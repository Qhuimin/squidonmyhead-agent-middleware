import { z } from "zod";

import{
    DEFAULT_MAX_STEPS,
    DEFAULT_MAX_CALLS_PER_MINUTE,
    DEFAULT_PER_CALL_TIMEOUT_MS,
    TEST_ATTACK_PHRASES
} from "./injection-constants.js"

import{
    PromptInjectionFilter,
    OutputValidator,
    HITLRiskScorer,
    Guardrail,
    StubGuardrail,
    buildStructuredPrompt,
} from "./injection-detector.js"

//

export type RiskTier = "read" | "low" | "medium" | "high" | "critical";

export interface ToolDefinition<TArgs, TResult> {
    name: string;
    description: string;
    risk: RiskTier;
    argsSchema: z.ZodType<TArgs>;
    resultSchema?: z.ZodType<TResult>;
    execute: (args: TArgs, ctx: ExecutionContext) => Promise<TResult>;
    isInScope: (args: TArgs, ctx: ExecutionContext) => boolean;
}

export interface ExecutionContext {
    taskId: string;
    allowedResources: Set<string>;
    capabilityToken: string;
    requestApproval: (req: ApprovalRequest) => Promise<boolean>;
}

export interface ApprovalRequest{
    toolName: string;
    risk: RiskTier;
    argsSummary: string;
    reasoning: string;
}

// 

export class ToolRegistry {
    private tools = new Map<string, ToolDefinition<any, any>>();

    register(tool:ToolDefinition<any, any>){
        this.tools.set(tool.name, tool);
    }

    getScopedRegistry(allowedToolNames: string[]): Map<string, ToolDefinition<any, any>> {
        const scopedTools = new Map<string, ToolDefinition<any, any>>();
        for (const name of allowedToolNames) {
            const tool = this.tools.get(name);
            if (tool) scopedTools.set(name, tool);
        }
        return scopedTools;
    }
}

//

export class ExecutionLimiter {
    private stepCount = 0;
    private callTimestamps: number[] = [];

    constructor(
        private readonly maxSteps = DEFAULT_MAX_STEPS,
        private readonly maxCallsPerMinute = DEFAULT_MAX_CALLS_PER_MINUTE,
        private readonly perCallTimeoutMs = DEFAULT_PER_CALL_TIMEOUT_MS
    ) { }

    checkStepBudget() {
        this.stepCount++;
        if (this.stepCount > this.maxSteps) {
            throw new Error(`Step budget exceeded (${this.maxSteps} max)`);
        }
    }

    checkRateLimit() {
        const now = Date.now();
        this.callTimestamps = this.callTimestamps.filter((t) => now - t < 60_000);
        if (this.callTimestamps.length >= this.maxCallsPerMinute) {
            throw new Error("Rate limit exceeded");
        }
        this.callTimestamps.push(now);
    }

    async withTimeout<T>(promise: Promise<T>): Promise<T> {
        return Promise.race([
            promise,
            new Promise<T>((_, reject) =>
                setTimeout(() => reject(new Error("Tool call timed out")), this.perCallTimeoutMs)
            ),
        ]);
    }
}

//

export class SafeAgentExecutor {
    private injectionFilter = new PromptInjectionFilter();
    private hitlScorer = new HITLRiskScorer();

    constructor(
        private registry: ToolRegistry,
        private limiter: ExecutionLimiter,
        private guardrail: Guardrail = new StubGuardrail(),
        private auditLog: (entry: Record<string, unknown>) => void = (e) => console.log("[audit]", e)
    ) { }

    async callTool(
        toolName: string,
        rawArgs: unknown,
        ctx: ExecutionContext,
        allowedToolNames: string[],
        taskGoal: string
    ): Promise<unknown> {
        const scopedTools = this.registry.getScopedRegistry(allowedToolNames);

        const tool = scopedTools.get(toolName);
        if (!tool) {
            this.auditLog({ event: "denied_unlisted_tool", toolName, taskId: ctx.taskId });
            throw new Error(`Tool "${toolName}" is not allowlisted for this task`);
        }

        this.limiter.checkStepBudget();
        this.limiter.checkRateLimit();

        const parsed = tool.argsSchema.safeParse(rawArgs);
        if (!parsed.success) {
            this.auditLog({ event: "denied_bad_schema", toolName, error: parsed.error.format() });
            throw new Error(`Invalid arguments for "${toolName}": ${parsed.error.message}`);
        }
        const args = parsed.data;

        if (!tool.isInScope(args, ctx)) {
            this.auditLog({ event: "denied_out_of_scope", toolName, args });
            throw new Error(`"${toolName}" call targets a resource outside task scope`);
        }

        const argsText = JSON.stringify(args);
        const scan = this.injectionFilter.detectInjection(argsText);
        if (scan.suspicious) {
            this.auditLog({ event: "denied_suspicious_args", toolName, scan });
            throw new Error(`"${toolName}" call arguments matched injection heuristics`);
        }

        const actionVerdict = await this.guardrail.screenAction(taskGoal, toolName, args);
        if (!actionVerdict.allowed) {
            this.auditLog({ event: "denied_guardrail_action", toolName, args, reason: actionVerdict.reason });
            throw new Error(`"${toolName}" call rejected: ${actionVerdict.reason}`);
        }

        const needsApproval = tool.risk !== "read" || this.hitlScorer.requiresApproval(argsText);
        if (needsApproval) {
            const approved = await ctx.requestApproval({
                toolName,
                risk: tool.risk,
                argsSummary: argsText.slice(0, 500),
                reasoning: `Task "${taskGoal}" requests ${tool.risk} action via ${toolName}`,
            });
            if (!approved) {
                this.auditLog({ event: "denied_approval_rejected", toolName, args });
                throw new Error(`"${toolName}" call rejected by approval gate`);
            }
        }

        this.auditLog({ event: "executing", toolName, args, taskId: ctx.taskId });
        const result = await this.limiter.withTimeout(tool.execute(args, ctx));

        if (tool.resultSchema) {
            const resultParsed = tool.resultSchema.safeParse(result);
            if (!resultParsed.success) {
                this.auditLog({ event: "denied_bad_result_schema", toolName, error: resultParsed.error.format() });
                throw new Error(`"${toolName}" returned a result that failed validation`);
            }
        }

        this.auditLog({ event: "success", toolName, taskId: ctx.taskId });
        return result;
    }
}

//

export class SecureLLMPipeline {
    private inputFilter = new PromptInjectionFilter();
    private outputValidator = new OutputValidator();
    private hitl = new HITLRiskScorer();

    constructor(
        private readonly generate: (prompt: string) => Promise<string>,
        private readonly guardrail: Guardrail = new StubGuardrail()
    ) { }

    async processRequest(userInput: string, systemPrompt: string): Promise<string> {
        const detection = this.inputFilter.detectInjection(userInput);
        if (detection.suspicious) {
            return "I cannot process that request.";
        }

        const inputVerdict = await this.guardrail.screenInput(userInput);
        if (!inputVerdict.allowed) {
            return "I cannot process that request.";
        }

        if (this.hitl.requiresApproval(userInput)) {
            return "Request submitted for human review.";
        }

        const cleanInput = this.inputFilter.sanitizeInput(userInput);
        const structuredPrompt = buildStructuredPrompt(systemPrompt, cleanInput);
        const response = await this.generate(structuredPrompt);

        const filtered = this.outputValidator.filterResponse(response);
        const outputVerdict = await this.guardrail.screenOutput(filtered);
        return outputVerdict.allowed ? filtered : "I cannot provide that information for security reasons.";
    }
}

//

export async function runSecurityTestSuite(pipeline: SecureLLMPipeline): Promise<number> {
    let blocked = 0;
    for (const attack of TEST_ATTACK_PHRASES) {
        const result = await pipeline.processRequest(attack, "You are a helpful assistant.");
        if (/cannot process|submitted for human review/i.test(result)) blocked++;
    }
    return blocked / TEST_ATTACK_PHRASES.length; // security score, 0..1
}
