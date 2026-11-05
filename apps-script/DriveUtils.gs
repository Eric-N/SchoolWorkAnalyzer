function spoGetOrCreateChildFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function spoHex_(bytes) {
  return bytes.map(b => {
    const v = b < 0 ? b + 256 : b;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function spoSha256Blob_(blob) {
  return spoHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, blob.getBytes()));
}

function spoParseScanDate_(file, timezone) {
  const name = file.getName();
  let m = name.match(/(?:^|\D)(\d{2})-(\d{2})-(\d{4})(?:\D|$)/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  m = name.match(/(?:^|\D)(\d{4})-(\d{2})-(\d{2})(?:\D|$)/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return Utilities.formatDate(file.getDateCreated(), timezone, 'yyyy-MM-dd');
}

function spoDateLabel_(isoDate) {
  const parts = isoDate.split('-');
  return `${parts[1]}-${parts[2]}-${parts[0]}`;
}

function spoVersionedName_(folder, filename) {
  if (!folder.getFilesByName(filename).hasNext()) return filename;
  const dot = filename.lastIndexOf('.');
  const stem = dot >= 0 ? filename.slice(0, dot) : filename;
  const ext = dot >= 0 ? filename.slice(dot) : '';
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-v${i}${ext}`;
    if (!folder.getFilesByName(candidate).hasNext()) return candidate;
  }
  throw new Error('Could not find an unused filename for ' + filename);
}

function spoCreateJsonResult_(analysis, scanDate, fileHash, resultsFolderId) {
  const folder = DriveApp.getFolderById(resultsFolderId);
  const name = `${spoDateLabel_(scanDate)}-${fileHash.slice(0, 8)}-analysis.json`;
  const blob = Utilities.newBlob(JSON.stringify(analysis, null, 2), 'application/json', name);
  return folder.createFile(blob);
}
