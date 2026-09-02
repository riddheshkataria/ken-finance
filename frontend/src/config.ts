/**
 * Runtime configuration.
 */
import { Platform } from 'react-native';

/**
 * Base URL of the Express API.
 *
 * The Android emulator cannot reach the host machine's `localhost` — that
 * resolves to the emulator itself. `10.0.2.2` is the alias the emulator
 * provides for the host loopback. Getting this wrong produces a silent
 * "network request failed" that looks like a backend bug, so it is handled
 * here once rather than in each caller.
 *
 * On a physical device neither works: set EXPO_PUBLIC_API_URL to the host
 * machine's LAN address (e.g. http://192.168.1.5:5000).
 */
export const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (Platform.OS === 'android' ? 'http://10.0.2.2:5000' : 'http://localhost:5000');

/**
 * Whether the LLM categorisation tier may be called at all.
 *
 * Independent of whether the backend has a key — this is the client-side
 * switch, so the paid tier can be turned off without touching the server.
 */
export const LLM_CATEGORIZATION_ENABLED: boolean =
  process.env.EXPO_PUBLIC_DISABLE_LLM !== 'true';
