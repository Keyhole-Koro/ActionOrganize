import { Firestore } from "@google-cloud/firestore";
import { env } from "../config/env.js";

let firestoreInstance: Firestore | undefined;

export function getFirestore(): Firestore {
  if (firestoreInstance) {
    return firestoreInstance;
  }

  firestoreInstance = new Firestore({
    projectId: env.GOOGLE_CLOUD_PROJECT,
    ignoreUndefinedProperties: true,
  });

  return firestoreInstance;
}
