import type { Db } from "../src/server/db/database";
import { setStoragePolicies } from "../src/server/lib/storagePolicies";
import type { StoragePolicyKind } from "../src/shared/types";

/** Sets a title's policy in each of the given folders. Policies are per folder, so tests name the folders. */
export async function assignTitle(db: Db, title: string, policy: StoragePolicyKind, sections: string[]): Promise<void> {
  await setStoragePolicies(db, sections.map((section) => ({ section, title })), policy);
}
