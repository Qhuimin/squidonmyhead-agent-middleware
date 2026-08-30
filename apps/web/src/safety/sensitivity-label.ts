import JSZip from "jszip";
import { PDFDocument, PDFName, PDFString, PDFHexString } from "pdf-lib";

const MSIP_LABEL_NAME_PATTERN = /^MSIP_Label_.*_Name$/i;

async function extractLabelFromDocx(file: File): Promise<string | null> {
  const zip = await JSZip.loadAsync(file);
  const customXmlFile = zip.file("docProps/custom.xml");
  if (!customXmlFile) return null;

  const xmlText = await customXmlFile.async("text");
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const properties = Array.from(doc.getElementsByTagName("property"));

  for (const property of properties) {
    const name = property.getAttribute("name") ?? "";
    if (MSIP_LABEL_NAME_PATTERN.test(name)) {
      const valueElement =
        property.getElementsByTagName("vt:lpwstr")[0] ?? property.getElementsByTagName("lpwstr")[0];
      if (valueElement?.textContent) return valueElement.textContent;
    }
  }
  return null;
}

async function extractLabelFromPdf(file: File): Promise<string | null> {
  const bytes = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
  const infoRef = pdfDoc.context.trailerInfo.Info;
  if (!infoRef) return null;

  const infoDict = pdfDoc.context.lookup(infoRef);
  if (!infoDict || typeof (infoDict as { entries?: unknown }).entries !== "function") return null;

  const entries = (infoDict as unknown as { entries: () => IterableIterator<[unknown, unknown]> }).entries();
  for (const [key, value] of entries) {
    const keyName = key instanceof PDFName ? key.decodeText() : String(key);
    if (MSIP_LABEL_NAME_PATTERN.test(keyName)) {
      if (value instanceof PDFString || value instanceof PDFHexString) {
        return value.decodeText();
      }
    }
  }
  return null;
}

export async function detectSensitivityLabel(file: File): Promise<string | null> {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".docx")) return await extractLabelFromDocx(file);
    if (name.endsWith(".pdf")) return await extractLabelFromPdf(file);
  } catch {
    return null;
  }
  return null;
}
