// Build-time helper only; never reads the application's connection Keychain item.
#import <Foundation/Foundation.h>
#import <Security/Security.h>

static int failed(OSStatus status) {
  fprintf(stderr, "Private build keychain operation failed (%d).\n", (int)status);
  return 1;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 4) return 2;
    NSString *command = [NSString stringWithUTF8String:argv[1]];
    NSData *password = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[3]]];
    if (!password || password.length < 32 || password.length > 256) return 2;
    // A private path outside login/System is deliberately used. Modern macOS
    // does not add private keychains to persistent search lists on creation.
    // Never call SetSearchList, SetDefault or change global trust settings.
    OSStatus status = SecKeychainSetUserInteractionAllowed(false);
    if (status) return failed(status);
    SecKeychainRef keychain = NULL;
    if ([command isEqualToString:@"create"]) {
      if (argc != 5) return 2;
      status = SecKeychainCreate(argv[2], (UInt32)password.length, password.bytes, false, NULL, &keychain);
      if (status) return failed(status);
      SecKeychainSettings settings = {SEC_KEYCHAIN_SETTINGS_VERS1, true, true, 600};
      status = SecKeychainSetSettings(keychain, &settings);
      if (status) return failed(status);
      SecTrustedApplicationRef trusted = NULL;
      status = SecTrustedApplicationCreateFromPath("/usr/bin/codesign", &trusted);
      if (status) return failed(status);
      CFArrayRef trustedApps = CFArrayCreate(NULL, (const void **)&trusted, 1, &kCFTypeArrayCallBacks);
      SecAccessRef access = NULL;
      status = SecAccessCreate(CFSTR("GEO Proof Lab local build signing key"), trustedApps, &access);
      CFRelease(trustedApps); CFRelease(trusted);
      if (status) return failed(status);
      NSData *p12 = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[4]]];
      if (!p12) return 2;
      SecExternalFormat format = kSecFormatPKCS12;
      SecExternalItemType type = kSecItemTypeAggregate;
      NSString *passphrase = [[NSString alloc] initWithData:password encoding:NSUTF8StringEncoding];
      SecItemImportExportKeyParameters parameters = {0};
      parameters.version = SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION;
      parameters.passphrase = (__bridge CFStringRef)passphrase;
      parameters.accessRef = access;
      status = SecItemImport((__bridge CFDataRef)p12, CFSTR("identity.p12"), &format, &type, 0, &parameters, keychain, NULL);
      CFRelease(access);
    } else if ([command isEqualToString:@"unlock"]) {
      if (argc != 4) return 2;
      status = SecKeychainOpen(argv[2], &keychain);
      if (!status) status = SecKeychainUnlock(keychain, (UInt32)password.length, password.bytes, true);
    } else return 2;
    if (keychain) CFRelease(keychain);
    if (status) return failed(status);
    return 0;
  }
}
