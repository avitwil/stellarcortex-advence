// Electron fuses (NFR-SEC-07): run-as-node off, asar integrity on, app only from asar.
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const ext = { darwin: '.app', win32: '.exe', linux: '' }[context.electronPlatformName];
  const name = context.packager.appInfo.productFilename;
  const exe = context.electronPlatformName === 'linux' ? path.join(context.appOutDir, context.packager.executableName) : path.join(context.appOutDir, `${name}${ext}`);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
};
