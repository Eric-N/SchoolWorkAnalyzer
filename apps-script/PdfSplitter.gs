/**
 * Apps Script has no built-in API for copying selected pages from one PDF into
 * a new PDF. This helper calls the tiny optional Cloud Run service included in
 * this project. If PDF_SPLITTER_URL is blank, analysis/email/state still work,
 * but derived category PDFs are skipped.
 */
function spoExtractPdfPages_(sourceBlob, pageNumbers, outputFolderId, filename, config) {
  if (!pageNumbers || !pageNumbers.length) return null;
  if (!config.pdfSplitterUrl) {
    spoLog_('WARN', '', `PDF splitter not configured; skipping ${filename} pages ${pageNumbers.join(',')}`);
    return null;
  }
  const payload = {
    filename: sourceBlob.getName() || 'scan.pdf',
    pages: Array.from(new Set(pageNumbers)).sort((a,b) => a-b),
    pdf_base64: Utilities.base64Encode(sourceBlob.getBytes()),
  };
  const headers = {};
  if (config.pdfSplitterToken) headers.Authorization = 'Bearer ' + config.pdfSplitterToken;
  const resp = UrlFetchApp.fetch(config.pdfSplitterUrl.replace(/\/$/, '') + '/extract', {
    method: 'post',
    contentType: 'application/json',
    headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error(`PDF splitter ${code}: ${resp.getContentText().slice(0,1000)}`);
  const folder = DriveApp.getFolderById(outputFolderId);
  const safeName = spoVersionedName_(folder, filename);
  const blob = resp.getBlob().setContentType(MimeType.PDF).setName(safeName);
  return folder.createFile(blob);
}
