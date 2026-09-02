/**
 * Local Expo module: native payment capture for Android.
 *
 * Consumers should import from src/native/kenIngestion.ts rather than here —
 * that wrapper degrades gracefully when the native module is absent (web, or
 * a build without it linked), which this raw handle does not.
 */
import { requireNativeModule } from 'expo-modules-core';

export default requireNativeModule('KenIngestion');
