import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { detectSensitivityLabel } from "../src/safety/sensitivity-label";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

function customXmlWithLabel(label: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="MSIP_Label_a1b2c3d4_Enabled"><vt:lpwstr>true</vt:lpwstr></property>
<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="MSIP_Label_a1b2c3d4_Name"><vt:lpwstr>${label}</vt:lpwstr></property>
</Properties>`;
}

async function buildFakeDocx(label: string | null): Promise<File> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELS);
  if (label) {
    zip.file("docProps/custom.xml", customXmlWithLabel(label));
  }
  const blob = await zip.generateAsync({ type: "blob" });
  return new File([blob], "test.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

describe("detectSensitivityLabel — docx", () => {
  it("detects a Highly Confidential label", async () => {
    const file = await buildFakeDocx("Highly Confidential");
    const label = await detectSensitivityLabel(file);
    expect(label).toBe("Highly Confidential");
  });

  it("detects a Confidential label", async () => {
    const file = await buildFakeDocx("Confidential");
    const label = await detectSensitivityLabel(file);
    expect(label).toBe("Confidential");
  });

  it("detects a Public label", async () => {
    const file = await buildFakeDocx("Public");
    const label = await detectSensitivityLabel(file);
    expect(label).toBe("Public");
  });

  it("returns null when the file has no custom.xml at all", async () => {
    const file = await buildFakeDocx(null);
    const label = await detectSensitivityLabel(file);
    expect(label).toBeNull();
  });

  it("returns null for a non-docx, non-pdf file", async () => {
    const file = new File(["plain text content"], "notes.txt", { type: "text/plain" });
    const label = await detectSensitivityLabel(file);
    expect(label).toBeNull();
  });

  it("does not throw on a corrupted/non-zip docx", async () => {
    const file = new File(["not actually a zip"], "broken.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await expect(detectSensitivityLabel(file)).resolves.toBeNull();
  });
});
