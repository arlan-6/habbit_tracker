import Dexie, { type Table } from "dexie";
import dexieCloud from "dexie-cloud-addon";

const dexieCloudDatabaseUrl = "https://zo89tpz08.dexie.cloud";

export type TrackerKind =
  | "boolean"
  | "quantity"
  | "duration"
  | "mood"
  | "note";

export interface Tracker {
  id: string;
  name: string;
  kind: TrackerKind;
  order: number;
  createdAt: string;
  archivedAt?: string;
}

export interface Entry {
  id: string;
  date: string;
  trackerId: string;
  value: boolean | number | string;
  updatedAt: string;
}

export interface DailyNote {
  date: string;
  text: string;
  updatedAt: string;
}

export interface JournalSetting {
  key: string;
  value: unknown;
}

class JournalDatabase extends Dexie {
  trackers!: Table<Tracker, string>;
  entries!: Table<Entry, string>;
  dailyNotes!: Table<DailyNote, string>;
  settings!: Table<JournalSetting, string>;

  constructor() {
    const isBrowser = typeof window !== "undefined";
    super("habit-log", isBrowser ? { addons: [dexieCloud] } : undefined);
    this.version(1).stores({
      trackers: "id, order, archivedAt",
      entries: "id, date, trackerId, [date+trackerId]",
      dailyNotes: "date",
      settings: "key",
    });
    this.version(2).stores({
      trackers: "id, order, archivedAt",
      entries: "id, date, trackerId, [date+trackerId]",
      dailyNotes: "date",
      settings: "key",
    });

    if (isBrowser) {
      this.cloud.configure({
        databaseUrl: dexieCloudDatabaseUrl,
        requireAuth: false,
        customLoginGui: true,
        nameSuffix: false,
      });
    }
  }
}

export const db = new JournalDatabase();

export const defaultTrackers: Tracker[] = [
  {
    id: "movement",
    name: "Movement",
    kind: "boolean",
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "water",
    name: "Water",
    kind: "quantity",
    order: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "reading",
    name: "Reading",
    kind: "duration",
    order: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "mood",
    name: "Mood",
    kind: "mood",
    order: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

export async function ensureDefaultTrackers() {
  const initialized = await db.settings.get("initialized");
  if (initialized) return;

  await db.transaction("rw", db.trackers, db.settings, async () => {
    await db.trackers.bulkPut(defaultTrackers);
    await db.settings.put({ key: "initialized", value: true });
  });
}
