// Larger real-world CJS packages from the parent node_modules.
const fs = require("fs"), os = require("os"), path = require("path");
const out = [];
try {
  const { Document, Packer, Paragraph, TextRun } = require("docx");
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun("Hello from kestrel")] })] }] });
  Packer.toBuffer(doc).then((buf) => {
    out.push("docx: " + (buf.length > 1000) + " " + buf.subarray(0, 2).toString());
    try {
      const PptxGenJS = require("pptxgenjs");
      const pptx = new PptxGenJS();
      pptx.addSlide().addText("kestrel", { x: 1, y: 1 });
      pptx.write({ outputType: "nodebuffer" }).then((b) => { out.push("pptxgenjs: " + (b.length > 1000)); done(); }, (e) => { out.push("pptxgenjs FAIL: " + e.message); done(); });
    } catch (e) { out.push("pptxgenjs FAIL: " + e.message.split("\n")[0]); done(); }
  }, (e) => { out.push("docx FAIL: " + e.message); done(); });
} catch (e) { out.push("docx FAIL: " + e.message.split("\n")[0]); done(); }
function done() {
  try { const { PDFDocument } = require("pdf-lib"); PDFDocument.create().then(async (pdf) => { pdf.addPage().drawText("kestrel"); const bytes = await pdf.save(); out.push("pdf-lib: " + (bytes.length > 500) + " " + String.fromCharCode(...bytes.subarray(0, 4))); finish(); }, (e) => { out.push("pdf-lib FAIL: " + e.message); finish(); }); }
  catch (e) { out.push("pdf-lib FAIL: " + e.message.split("\n")[0]); finish(); }
}
function finish() {
  try { const pako = require("pako"); out.push("pako: " + pako.inflate(pako.deflate("x")).length); } catch (e) { out.push("pako FAIL " + e.message); }
  try { const { marked } = require("marked"); out.push("marked: " + marked.parse("*a*").trim()); } catch (e) { out.push("marked FAIL " + e.message); }
  try { const sz = require("image-size"); out.push("image-size: " + typeof (sz.imageSize || sz.default || sz)); } catch (e) { out.push("image-size FAIL " + e.message.split("\n")[0]); }
  try { const { PNG } = require("pngjs"); const png = new PNG({ width: 2, height: 2 }); png.data.fill(255); out.push("pngjs: " + PNG.sync.write(png).length); } catch (e) { out.push("pngjs FAIL " + e.message.split("\n")[0]); }
  try { const jpeg = require("jpeg-js"); const raw = { data: Buffer.alloc(4 * 4, 200), width: 2, height: 2 }; out.push("jpeg-js: " + jpeg.encode(raw, 80).data.length); } catch (e) { out.push("jpeg-js FAIL " + e.message.split("\n")[0]); }
  console.log(out.join("\n"));
}
