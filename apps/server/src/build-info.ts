// Values fixed at build time for the setup wizard (FR-GGL-01).
export const ANDROID_PACKAGE = 'com.stellarcortex.advence';
/** SHA-1 of the release APK signing certificate; set by the release build. */
export const ANDROID_SIGNING_SHA1 = process.env.ADVENCE_ANDROID_SHA1 ?? 'set-by-release-build';
