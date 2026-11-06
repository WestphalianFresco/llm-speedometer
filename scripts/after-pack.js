'use strict'

/**
 * electron-builder afterPack hook: stamp the Windows executable with the app's
 * own icon and version strings.
 *
 * electron-builder does this itself as part of signAndEditExecutable, but that
 * step first downloads and unpacks its winCodeSign toolchain, and the archive
 * contains macOS symlinks that Windows refuses to create without Developer
 * Mode or an elevated shell. The build died on that every time, so the option
 * is off in package.json — which also means the packaged exe shipped with the
 * stock Electron icon and "Electron" as its description in Task Manager.
 *
 * rcedit is a single self-contained exe, so calling it here does the same
 * resource edit without any of that. It runs on the unpacked exe before the
 * NSIS installer and the portable build wrap it, so both inherit the result.
 */
const path = require('path')
const fs = require('fs')

module.exports = async function afterPack (context) {
  if (context.electronPlatformName !== 'win32') return
  // rcedit is a Windows binary; elsewhere it would need wine, and that is the
  // path electron-builder already handles for cross builds.
  if (process.platform !== 'win32') {
    console.log('  • after-pack: not on Windows, leaving the exe resources alone')
    return
  }

  const { rcedit } = require('rcedit')
  const { appInfo } = context.packager
  const exe = path.join(context.appOutDir, `${appInfo.productFilename}.exe`)
  const icon = path.resolve(__dirname, '..', 'build', 'icon.ico')

  if (!fs.existsSync(exe)) throw new Error(`after-pack: executable not found at ${exe}`)
  if (!fs.existsSync(icon)) throw new Error(`after-pack: icon not found at ${icon}`)

  await rcedit(exe, {
    icon,
    'file-version': appInfo.shortVersion || appInfo.buildVersion,
    'product-version': appInfo.shortVersionWindows || appInfo.getVersionInWeirdWindowsForm(),
    'version-string': {
      ProductName: appInfo.productName,
      FileDescription: appInfo.description || appInfo.productName,
      CompanyName: appInfo.companyName || '',
      LegalCopyright: appInfo.copyright,
      InternalName: appInfo.productFilename,
      OriginalFilename: `${appInfo.productFilename}.exe`
    }
  })
  console.log(`  • after-pack: set icon and version info on ${path.basename(exe)}`)
}
