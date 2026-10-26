import fs from "node:fs";
import path from "node:path";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const MAX_CHARS = 30000;
const TEXT_EXTENSIONS = new Set([".txt", ".csv", ".md", ".json", ".tsv"]);

/**
 * Turns an uploaded datasheet into plain text the model can read directly.
 * PDFs are parsed on the server so the agent does not have to open the file itself.
 */
export async function extractDocumentText(file) {
  const extension = path.extname(file.path).toLowerCase();

  if (TEXT_EXTENSIONS.has(extension)) {
    return fs.readFileSync(file.path, "utf8").replace(/\r\n/g, "\n").trim().slice(0, MAX_CHARS);
  }

  if (extension !== ".pdf") return "";

  const data = await pdfParse(fs.readFileSync(file.path));
  const text = (data.text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text.slice(0, MAX_CHARS);
}
