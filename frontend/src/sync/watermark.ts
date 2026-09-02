/**
 * The "last successfully pulled" marker.
 *
 * Kept in AsyncStorage rather than SQLite because it is a single scalar with
 * no relationship to any row, and because it must survive a database
 * migration failure — losing it only costs one full re-pull, whereas losing
 * it silently alongside the data would cause rows to be skipped forever.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'ken.sync.lastPulledAt';

export async function readWatermark(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEY);
  } catch {
    // A null watermark means "pull everything", which is always safe.
    return null;
  }
}

export async function writeWatermark(value: string | null): Promise<void> {
  try {
    if (value === null) await AsyncStorage.removeItem(KEY);
    else await AsyncStorage.setItem(KEY, value);
  } catch {
    // Worst case the next sync re-pulls; never worth failing the cycle for.
  }
}
