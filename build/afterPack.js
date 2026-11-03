'use strict';
// Escribe en Porter.exe sus propios datos (nombre, versión, autor, copyright, icono)
// en lugar de los genéricos de Electron. Windows y los antivirus muestran y usan esta información.
const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const pkg = ctx.packager.appInfo;
  const exe = path.join(ctx.appOutDir, `${pkg.productFilename}.exe`);
  const exeData = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exeData);

  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const iconId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, iconId, lang, ico.icons.map((i) => i.data));

  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const v = pkg.version.split('.').map(Number);
  vi.setFileVersion(v[0], v[1], v[2], 0, 1033);
  vi.setProductVersion(v[0], v[1], v[2], 0, 1033);
  const strings = {
    CompanyName: 'Fireaced',
    FileDescription: 'Porter - Lector de manga y cómics',
    ProductName: 'Porter',
    InternalName: 'Porter',
    OriginalFilename: 'Porter.exe',
    LegalCopyright: `© ${new Date().getFullYear()} Fireaced. Licencia MIT.`,
    FileVersion: pkg.version,
    ProductVersion: pkg.version,
  };
  for (const l of vi.getAllLanguagesForStringValues()) {
    vi.setStringValues(l, strings);
  }
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exeData);
  fs.writeFileSync(exe, Buffer.from(exeData.generate()));
  console.log('  • metadatos e icono escritos en', path.basename(exe));
};
