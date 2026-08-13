"use client";

import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  resolveText,
  type DXCInputField,
  type DXCOption,
  type DXCUserInteraction,
  type SyncState,
  type UserLogin,
} from "dexie-cloud-addon";
import {
  db,
  defaultTrackers,
  ensureDefaultTrackers,
  type DailyNote,
  type Entry,
  type JournalSetting,
  type Tracker,
  type TrackerKind,
} from "./db";

type ViewMode = "day" | "week" | "month";
type DropPosition = "before" | "after";

const kindLabels: Record<TrackerKind, string> = {
  boolean: "yes / no",
  quantity: "number",
  duration: "minutes",
  mood: "1 — 5",
  note: "short note",
};

const kindMarks: Record<TrackerKind, string> = {
  boolean: "[×]",
  quantity: "#",
  duration: "00m",
  mood: ":)",
  note: "\"",
};

const trackerKinds = Object.keys(kindLabels) as TrackerKind[];
const dayColumnWidth = 72;
const momentColumnMinWidth = 270;
const trackerColumnWidth = 92;
const moodColumnWidth = 150;

interface BackupV1 {
  schemaVersion: 1;
  exportedAt?: string;
  trackers: Tracker[];
  entries: Entry[];
  dailyNotes: DailyNote[];
  settings: JournalSetting[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTracker(value: unknown): value is Tracker {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    trackerKinds.includes(value.kind as TrackerKind) &&
    typeof value.order === "number" &&
    Number.isFinite(value.order) &&
    typeof value.createdAt === "string" &&
    (value.archivedAt === undefined || typeof value.archivedAt === "string")
  );
}

function isEntry(value: unknown): value is Entry {
  if (!isRecord(value)) return false;
  const entryValue = value.value;
  return (
    typeof value.id === "string" &&
    typeof value.date === "string" &&
    typeof value.trackerId === "string" &&
    typeof value.updatedAt === "string" &&
    (typeof entryValue === "boolean" ||
      typeof entryValue === "string" ||
      (typeof entryValue === "number" && Number.isFinite(entryValue)))
  );
}

function isDailyNote(value: unknown): value is DailyNote {
  return (
    isRecord(value) &&
    typeof value.date === "string" &&
    typeof value.text === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isSetting(value: unknown): value is JournalSetting {
  return isRecord(value) && typeof value.key === "string";
}

function parseBackup(text: string): BackupV1 {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.trackers) ||
    !value.trackers.every(isTracker) ||
    !Array.isArray(value.entries) ||
    !value.entries.every(isEntry) ||
    !Array.isArray(value.dailyNotes) ||
    !value.dailyNotes.every(isDailyNote) ||
    (value.settings !== undefined &&
      (!Array.isArray(value.settings) || !value.settings.every(isSetting)))
  ) {
    throw new Error("Invalid backup");
  }

  return {
    schemaVersion: 1,
    exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : undefined,
    trackers: value.trackers,
    entries: value.entries,
    dailyNotes: value.dailyNotes,
    settings: Array.isArray(value.settings) ? value.settings : [],
  };
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fromDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function monthKey(date: Date) {
  return toDateKey(new Date(date.getFullYear(), date.getMonth(), 1)).slice(0, 7);
}

function monthBounds(value: string) {
  const [year, month] = value.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  return { first, last, start: toDateKey(first), end: toDateKey(last) };
}

function daysInMonth(value: string) {
  const { first, last } = monthBounds(value);
  const days: Date[] = [];
  for (let day = first.getDate(); day <= last.getDate(); day += 1) {
    days.push(new Date(first.getFullYear(), first.getMonth(), day));
  }
  return days;
}

function shiftDate(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

function shiftMonth(value: string, amount: number) {
  const { first } = monthBounds(value);
  return monthKey(new Date(first.getFullYear(), first.getMonth() + amount, 1));
}

function formatPeriod(value: string) {
  const { first } = monthBounds(value);
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
  }).format(first);
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.matches("input, select, textarea") || target.isContentEditable)
  );
}

interface DraftTextInputProps {
  ariaLabel: string;
  className: string;
  maxLength: number;
  onCommit: (value: string) => Promise<void>;
  placeholder: string;
  value: string;
}

function DraftTextInput({
  ariaLabel,
  className,
  maxLength,
  onCommit,
  placeholder,
  value,
}: DraftTextInputProps) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const persistedRef = useRef(value);
  const commitRef = useRef(onCommit);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    commitRef.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    persistedRef.current = value;
    if (timerRef.current === null) {
      draftRef.current = value;
      setDraft(value);
    }
  }, [value]);

  const flush = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const nextValue = draftRef.current;
    if (nextValue === persistedRef.current) return;
    persistedRef.current = nextValue;
    void commitRef.current(nextValue);
  };

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (draftRef.current !== persistedRef.current) {
        void commitRef.current(draftRef.current);
      }
    },
    [],
  );

  return (
    <input
      aria-label={ariaLabel}
      className={className}
      maxLength={maxLength}
      placeholder={placeholder}
      value={draft}
      onBlur={flush}
      onChange={(event) => {
        const nextValue = event.target.value;
        draftRef.current = nextValue;
        setDraft(nextValue);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(flush, 250);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function CloudInteractionForm({ interaction }: { interaction: DXCUserInteraction }) {
  const fields = Object.entries(interaction.fields) as [string, DXCInputField][];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map(([name]) => [name, ""])),
  );
  const submitInteraction = (params: Record<string, string>) => {
    const onSubmit = interaction.onSubmit as (nextValues: Record<string, string>) => void;
    onSubmit(params);
  };

  useEffect(() => {
    if (!interaction.cancelLabel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") interaction.onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [interaction]);

  return (
    <div className="cloud-dialog-layer">
      <form
        aria-labelledby="cloud-dialog-title"
        aria-modal="true"
        className="cloud-dialog-card"
        role="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submitInteraction(values);
        }}
      >
        <div className="dialog-header">
          <div>
            <p className="eyebrow">Private cloud sync</p>
            <h2 className="dialog-title" id="cloud-dialog-title">
              {interaction.title}
            </h2>
          </div>
        </div>

        <div className="dialog-body cloud-dialog-body">
          {interaction.alerts.map((alert, index) => (
            <div className={`cloud-alert is-${alert.type}`} key={`${alert.messageCode}-${index}`}>
              <span>{resolveText(alert)}</span>
              {alert.copyText && <code>{alert.copyText}</code>}
            </div>
          ))}

          {("options" in interaction ? interaction.options : undefined)?.map((option: DXCOption) => (
            <button
              className="cloud-option-button"
              key={`${option.name}-${option.value}`}
              type="button"
              onClick={() => submitInteraction({ [option.name]: option.value })}
            >
              {option.displayName}
            </button>
          ))}

          {fields.map(([name, field]) => (
            <label className="field-label" key={name}>
              {field.label ?? (name === "otp" ? "One-time code" : name)}
              <input
                autoComplete={name === "email" ? "email" : name === "otp" ? "one-time-code" : "off"}
                className="dialog-input"
                inputMode={name === "otp" ? "numeric" : name === "email" ? "email" : "text"}
                name={name}
                placeholder={field.placeholder}
                required
                type={field.type === "otp" ? "text" : field.type}
                value={values[name] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [name]: event.target.value }))
                }
              />
            </label>
          ))}
        </div>

        <div className="dialog-footer">
          {interaction.cancelLabel ? (
            <button className="terminal-button" type="button" onClick={interaction.onCancel}>
              {interaction.cancelLabel}
            </button>
          ) : (
            <span />
          )}
          <button className="terminal-button" type="submit">
            {interaction.submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function CloudInteractionDialog({ interaction }: { interaction?: DXCUserInteraction }) {
  if (!interaction) return null;
  return (
    <CloudInteractionForm
      interaction={interaction}
      key={`${interaction.type}:${interaction.title}`}
    />
  );
}

export function HabitJournal() {
  const initialTodayKey = useMemo(() => toDateKey(new Date()), []);
  const [todayKey, setTodayKey] = useState(initialTodayKey);
  const [selectedMonth, setSelectedMonth] = useState(() => initialTodayKey.slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(initialTodayKey);
  const [view, setView] = useState<ViewMode>("month");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [status, setStatus] = useState("Ready");
  const [statusError, setStatusError] = useState(false);
  const [trackerDialogOpen, setTrackerDialogOpen] = useState(false);
  const [newTrackerName, setNewTrackerName] = useState("");
  const [newTrackerKind, setNewTrackerKind] = useState<TrackerKind>("boolean");
  const [draggedTrackerId, setDraggedTrackerId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    position: DropPosition;
  } | null>(null);
  const [cloudUser, setCloudUser] = useState<UserLogin>();
  const [cloudSyncState, setCloudSyncState] = useState<SyncState>();
  const [cloudInteraction, setCloudInteraction] = useState<DXCUserInteraction>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const ledgerRef = useRef<HTMLElement>(null);
  const dataMenuRef = useRef<HTMLDetailsElement>(null);
  const syncMenuRef = useRef<HTMLDetailsElement>(null);

  const cloudStatus = !cloudUser?.isLoggedIn
    ? "Local"
    : cloudSyncState?.phase === "pushing" || cloudSyncState?.phase === "pulling"
      ? "Syncing"
      : cloudSyncState?.phase === "error" || cloudSyncState?.status === "error"
        ? "Sync error"
        : cloudSyncState?.phase === "offline" || cloudSyncState?.status === "offline"
          ? "Offline"
          : "Synced";
  const cloudStatusTone = cloudStatus === "Sync error"
    ? "is-error"
    : cloudStatus === "Synced"
      ? "is-synced"
      : "";

  useEffect(() => {
    const subscriptions = [
      db.cloud.currentUser.subscribe(setCloudUser),
      db.cloud.syncState.subscribe(setCloudSyncState),
      db.cloud.userInteraction.subscribe(setCloudInteraction),
    ];
    return () => subscriptions.forEach((subscription) => subscription.unsubscribe());
  }, []);

  useEffect(() => {
    ensureDefaultTrackers().catch(() => {
      setStatus("Could not open local journal");
      setStatusError(true);
    });
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (trackerDialogOpen && !dialog.open) dialog.showModal();
    if (!trackerDialogOpen && dialog.open) dialog.close();
  }, [trackerDialogOpen]);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;

    const prepareOfflineShell = async () => {
      const registration = await navigator.serviceWorker.register("/sw.js");
      const readyRegistration = await navigator.serviceWorker.ready;
      const assetUrls = Array.from(
        document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
          'script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]',
        ),
      )
        .map((node) => (node instanceof HTMLScriptElement ? node.src : node.href))
        .filter((url) => new URL(url, window.location.href).origin === window.location.origin)
        .map((url) => new URL(url, window.location.href).pathname);

      (registration.active ?? readyRegistration.active)?.postMessage({
        type: "CACHE_SHELL",
        urls: [window.location.pathname, ...new Set(assetUrls)],
      });
    };

    prepareOfflineShell().catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setTodayKey(toDateKey(new Date())), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const visibleDays = useMemo(() => {
    if (view === "month") return daysInMonth(selectedMonth);
    const selected = fromDateKey(selectedDate);
    if (view === "day") return [selected];
    const mondayOffset = (selected.getDay() + 6) % 7;
    const weekStart = shiftDate(selected, -mondayOffset);
    return Array.from({ length: 7 }, (_, index) => shiftDate(weekStart, index));
  }, [selectedDate, selectedMonth, view]);

  const queryBounds = useMemo(() => {
    const firstVisibleDay = visibleDays[0];
    const lastVisibleDay = visibleDays.at(-1);
    if (!firstVisibleDay || !lastVisibleDay) return monthBounds(selectedMonth);
    return { start: toDateKey(firstVisibleDay), end: toDateKey(lastVisibleDay) };
  }, [selectedMonth, visibleDays]);

  const allTrackers = useLiveQuery(
    () => db.trackers.orderBy("order").toArray(),
    [],
    [],
  );
  const trackers = useMemo(
    () => allTrackers.filter((tracker) => !tracker.archivedAt),
    [allTrackers],
  );
  const archivedTrackers = useMemo(
    () => allTrackers.filter((tracker) => tracker.archivedAt),
    [allTrackers],
  );
  const ledgerMinWidth =
    dayColumnWidth +
    momentColumnMinWidth +
    trackers.reduce(
      (width, tracker) =>
        width + (tracker.kind === "mood" ? moodColumnWidth : trackerColumnWidth),
      0,
    );
  const entries = useLiveQuery(
    () => db.entries.where("date").between(queryBounds.start, queryBounds.end, true, true).toArray(),
    [queryBounds.start, queryBounds.end],
    [],
  );
  const notes = useLiveQuery(
    () => db.dailyNotes.where("date").between(queryBounds.start, queryBounds.end, true, true).toArray(),
    [queryBounds.start, queryBounds.end],
    [],
  );

  const entryMap = useMemo(
    () => new Map(entries.map((entry) => [`${entry.date}:${entry.trackerId}`, entry])),
    [entries],
  );
  const noteMap = useMemo(() => new Map(notes.map((note) => [note.date, note.text])), [notes]);

  useEffect(() => {
    const frame = ledgerRef.current;
    const row = frame?.querySelector<HTMLTableRowElement>(`tr[data-date="${selectedDate}"]`);
    if (!frame || !row) return;

    const headerHeight = frame.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    const visibleTop = frame.scrollTop + headerHeight;
    const visibleBottom = frame.scrollTop + frame.clientHeight;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;

    if (rowTop < visibleTop || rowBottom > visibleBottom) {
      frame.scrollTo({
        top: Math.max(0, rowTop - frame.clientHeight / 2 + row.offsetHeight / 2),
        behavior: "auto",
      });
    }
  }, [selectedDate, selectedMonth, view, visibleDays.length]);

  const markSaved = (message = "Saved") => {
    setSavedAt(new Date());
    setStatus(message);
    setStatusError(false);
  };

  const markError = (message: string) => {
    setStatus(message);
    setStatusError(true);
  };

  const saveEntry = async (date: string, tracker: Tracker, value: Entry["value"] | undefined) => {
    const id = `${date}:${tracker.id}`;
    try {
      if (value === undefined || value === "") {
        await db.entries.delete(id);
      } else {
        await db.entries.put({
          id,
          date,
          trackerId: tracker.id,
          value,
          updatedAt: new Date().toISOString(),
        });
      }
      markSaved();
    } catch {
      markError("Entry was not saved");
    }
  };

  const saveDailyNote = async (date: string, text: string) => {
    try {
      if (!text.trim()) {
        await db.dailyNotes.delete(date);
      } else {
        await db.dailyNotes.put({ date, text: text.slice(0, 200), updatedAt: new Date().toISOString() });
      }
      markSaved();
    } catch {
      markError("Note was not saved");
    }
  };

  const movePeriod = (amount: number) => {
    if (view === "month") {
      const nextMonth = shiftMonth(selectedMonth, amount);
      setSelectedMonth(nextMonth);
      const { last } = monthBounds(nextMonth);
      const preferredDay = Math.min(fromDateKey(selectedDate).getDate(), last.getDate());
      setSelectedDate(toDateKey(new Date(last.getFullYear(), last.getMonth(), preferredDay)));
      return;
    }
    const nextDate = shiftDate(fromDateKey(selectedDate), amount * (view === "week" ? 7 : 1));
    setSelectedDate(toDateKey(nextDate));
    setSelectedMonth(monthKey(nextDate));
  };

  const goToday = () => {
    setSelectedMonth(todayKey.slice(0, 7));
    setSelectedDate(todayKey);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || trackerDialogOpen) return;
      if (event.key === "[") movePeriod(-1);
      if (event.key === "]") movePeriod(1);
      if (event.key.toLowerCase() === "d") setView("day");
      if (event.key.toLowerCase() === "w") setView("week");
      if (event.key.toLowerCase() === "m") setView("month");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const createTracker = async (event: FormEvent) => {
    event.preventDefault();
    const name = newTrackerName.trim();
    if (!name) return;
    const tracker: Tracker = {
      id: crypto.randomUUID(),
      name: name.slice(0, 24),
      kind: newTrackerKind,
      order: Math.max(-1, ...allTrackers.map((item) => item.order)) + 1,
      createdAt: new Date().toISOString(),
    };
    try {
      await db.trackers.add(tracker);
      setNewTrackerName("");
      setNewTrackerKind("boolean");
      markSaved("Tracker added");
    } catch {
      markError("Tracker was not added");
    }
  };

  const archiveTracker = async (tracker: Tracker) => {
    try {
      await db.trackers.update(tracker.id, { archivedAt: new Date().toISOString() });
      markSaved("Tracker archived");
    } catch {
      markError("Tracker was not archived");
    }
  };

  const restoreTracker = async (tracker: Tracker) => {
    try {
      await db.trackers.update(tracker.id, { archivedAt: undefined });
      markSaved("Tracker restored");
    } catch {
      markError("Tracker was not restored");
    }
  };

  const beginCloudLogin = () => {
    syncMenuRef.current?.removeAttribute("open");
    void db.cloud.login().then(
      () => markSaved("Cloud sync enabled"),
      (error: unknown) => {
        if (error instanceof Error && /cancel/i.test(error.message)) return;
        markError("Could not sign in to cloud sync");
      },
    );
  };

  const syncCloudNow = async () => {
    syncMenuRef.current?.removeAttribute("open");
    try {
      await db.cloud.sync({ purpose: "push", wait: true });
      await db.cloud.sync({ purpose: "pull", wait: true });
      markSaved("Cloud sync complete");
    } catch {
      markError("Cloud sync failed");
    }
  };

  const logoutFromCloud = () => {
    syncMenuRef.current?.removeAttribute("open");
    void db.cloud.logout().then(
      () => markSaved("Cloud sync signed out"),
      (error: unknown) => {
        if (error instanceof Error && /cancel/i.test(error.message)) return;
        markError("Could not sign out");
      },
    );
  };

  const reorderTrackers = async (
    sourceId: string,
    targetId: string,
    position: DropPosition,
  ) => {
    if (sourceId === targetId) return;

    const source = trackers.find((tracker) => tracker.id === sourceId);
    const remaining = trackers.filter((tracker) => tracker.id !== sourceId);
    const targetIndex = remaining.findIndex((tracker) => tracker.id === targetId);
    if (!source || targetIndex === -1) return;

    const insertAt = targetIndex + (position === "after" ? 1 : 0);
    remaining.splice(insertAt, 0, source);
    const orderSlots = trackers.map((tracker) => tracker.order).sort((a, b) => a - b);

    try {
      await db.transaction("rw", db.trackers, async () => {
        await Promise.all(
          remaining.map((tracker, index) =>
            db.trackers.update(tracker.id, { order: orderSlots[index] }),
          ),
        );
      });
      markSaved("Trackers reordered");
    } catch {
      markError("Tracker order was not saved");
    } finally {
      setDraggedTrackerId(null);
      setDropTarget(null);
    }
  };

  const moveTrackerWithKeyboard = (trackerId: string, direction: -1 | 1) => {
    const index = trackers.findIndex((tracker) => tracker.id === trackerId);
    const target = trackers[index + direction];
    if (index === -1 || !target) return;

    void reorderTrackers(
      trackerId,
      target.id,
      direction === -1 ? "before" : "after",
    );
  };

  const exportBackup = async () => {
    try {
      const backup: BackupV1 = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        trackers: await db.trackers.toArray(),
        entries: await db.entries.toArray(),
        dailyNotes: await db.dailyNotes.toArray(),
        settings: await db.settings.toArray(),
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `habit-log-${todayKey}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      dataMenuRef.current?.removeAttribute("open");
      markSaved("Backup exported");
    } catch {
      markError("Backup could not be exported");
    }
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("Backup is too large");
      const backup = parseBackup(await file.text());
      if (!window.confirm("Replace the journal on this device with this backup?")) return;
      await db.transaction("rw", db.trackers, db.entries, db.dailyNotes, db.settings, async () => {
        await Promise.all([
          db.trackers.clear(),
          db.entries.clear(),
          db.dailyNotes.clear(),
          db.settings.clear(),
        ]);
        await db.trackers.bulkPut(backup.trackers);
        await db.entries.bulkPut(backup.entries);
        await db.dailyNotes.bulkPut(backup.dailyNotes);
        await db.settings.bulkPut(backup.settings);
        await db.settings.put({ key: "initialized", value: true });
      });
      dataMenuRef.current?.removeAttribute("open");
      markSaved("Backup restored");
    } catch {
      markError("That backup could not be restored");
    } finally {
      event.target.value = "";
    }
  };

  const resetJournal = async () => {
    if (!window.confirm("Delete every local entry and restore the default trackers? This cannot be undone.")) {
      return;
    }
    try {
      await db.transaction("rw", db.trackers, db.entries, db.dailyNotes, db.settings, async () => {
        await Promise.all([
          db.trackers.clear(),
          db.entries.clear(),
          db.dailyNotes.clear(),
          db.settings.clear(),
        ]);
        await db.trackers.bulkPut(defaultTrackers);
        await db.settings.put({ key: "initialized", value: true });
      });
      dataMenuRef.current?.removeAttribute("open");
      markSaved("Local journal reset");
    } catch {
      markError("Local journal was not reset");
    }
  };

  const renderTrackerCell = (date: string, tracker: Tracker) => {
    const entry = entryMap.get(`${date}:${tracker.id}`);
    const value = entry?.value;

    if (tracker.kind === "boolean") {
      const checked = value === true;
      return (
        <button
          className={`cell-button ${checked ? "is-checked" : ""}`}
          aria-label={`${tracker.name} on ${date}: ${checked ? "complete" : "not complete"}`}
          aria-pressed={checked}
          onClick={() => saveEntry(date, tracker, !checked)}
          onKeyDown={(event) => {
            if (event.key !== " ") return;
            event.preventDefault();
            void saveEntry(date, tracker, !checked);
          }}
        >
          {checked ? "×" : "·"}
        </button>
      );
    }

    if (tracker.kind === "mood") {
      return (
        <div className="mood-cell" aria-label={`${tracker.name} on ${date}`} role="group">
          {[1, 2, 3, 4, 5].map((score) => (
            <button
              key={score}
              data-score={score}
              className={`mood-button ${value === score ? "is-active" : ""}`}
              aria-label={`Set mood to ${score} of 5`}
              aria-pressed={value === score}
              tabIndex={value === score || (value === undefined && score === 3) ? 0 : -1}
              onClick={() => saveEntry(date, tracker, value === score ? undefined : score)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const nextScore = Math.min(
                  5,
                  Math.max(1, score + (event.key === "ArrowRight" ? 1 : -1)),
                );
                saveEntry(date, tracker, nextScore);
                event.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>(`[data-score="${nextScore}"]`)
                  ?.focus();
              }}
            >
              {score}
            </button>
          ))}
        </div>
      );
    }

    if (tracker.kind === "note") {
      return (
        <DraftTextInput
          ariaLabel={`${tracker.name} on ${date}`}
          className="cell-input"
          maxLength={80}
          onCommit={(nextValue) => saveEntry(date, tracker, nextValue)}
          placeholder="—"
          value={typeof value === "string" ? value : ""}
        />
      );
    }

    return (
      <input
        className="cell-input number-input"
        aria-label={`${tracker.name} on ${date}`}
        inputMode="decimal"
        min="0"
        placeholder={tracker.kind === "duration" ? "min" : "—"}
        step={tracker.kind === "duration" ? "1" : "any"}
        type="number"
        value={typeof value === "number" ? value : ""}
        onChange={(event) => {
          const rawValue = event.target.value;
          if (rawValue === "") {
            saveEntry(date, tracker, undefined);
            return;
          }

          const numberValue = Number(rawValue);
          if (
            !Number.isFinite(numberValue) ||
            numberValue < 0 ||
            (tracker.kind === "duration" && !Number.isInteger(numberValue))
          ) {
            markError(
              tracker.kind === "duration"
                ? "Duration must be whole minutes"
                : "Quantity must be zero or higher",
            );
            return;
          }
          saveEntry(date, tracker, numberValue);
        }}
      />
    );
  };

  return (
    <main className="journal-shell">
      <section className="period-bar" aria-labelledby="period-heading">
        <div>
          <p className="eyebrow">Journal / {selectedMonth}</p>
          <h1 className="period-title" id="period-heading">
            {formatPeriod(selectedMonth)}
          </h1>
        </div>
        <div className="period-controls">
          <button className="terminal-button" onClick={() => movePeriod(-1)} aria-label="Previous period">
            ←
          </button>
          <button className="terminal-button" onClick={goToday}>
            Today
          </button>
          <button className="terminal-button" onClick={() => movePeriod(1)} aria-label="Next period">
            →
          </button>
          <div className="view-switcher" aria-label="Journal view" role="group">
            {(["day", "week", "month"] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                className={`view-button ${view === mode ? "is-active" : ""}`}
                aria-pressed={view === mode}
                onClick={() => setView(mode)}
              >
                [{mode[0]}] {mode}
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="toolbar">
        <div className="keyboard-hint" aria-hidden="true">
          <span className="kbd">[ ]</span> period&nbsp;&nbsp;
          <span className="kbd">D W M</span> view&nbsp;&nbsp;
          <span className="kbd">TAB</span> move&nbsp;&nbsp;
          <span className="kbd">SPACE</span> toggle
        </div>
        <div className="toolbar-actions">
          <button className="terminal-button" onClick={() => setTrackerDialogOpen(true)}>
            + Trackers
          </button>
          <details className="data-menu" ref={syncMenuRef}>
            <summary
              aria-label={`Cloud sync: ${cloudStatus}`}
              className={`terminal-button sync-summary ${cloudStatusTone}`}
            >
              <span aria-hidden="true" className="sync-dot" />
              {cloudStatus}
            </summary>
            <div className="menu-panel sync-menu-panel">
              {cloudUser?.isLoggedIn ? (
                <>
                  <p className="sync-account">{cloudUser.email ?? cloudUser.userId}</p>
                  <button type="button" onClick={syncCloudNow}>Sync now</button>
                  <button className="danger-action" type="button" onClick={logoutFromCloud}>
                    Sign out
                  </button>
                </>
              ) : (
                <>
                  <p className="sync-menu-copy">
                    Sign in with the same email on every device.
                  </p>
                  <button type="button" onClick={beginCloudLogin}>Sign in to sync</button>
                </>
              )}
            </div>
          </details>
          <details className="data-menu" ref={dataMenuRef}>
            <summary className="terminal-button" aria-label="Data options">Data</summary>
            <div className="menu-panel">
              <button onClick={exportBackup}>Export backup</button>
              <label className="file-label" htmlFor="backup-file">
                Import backup
              </label>
              <input
                className="sr-only"
                id="backup-file"
                type="file"
                accept="application/json,.json"
                onChange={importBackup}
              />
              <button className="danger-action" onClick={resetJournal}>
                Reset local journal
              </button>
            </div>
          </details>
        </div>
      </div>

      <section
        className="ledger-frame"
        aria-label={`${formatPeriod(selectedMonth)} habit journal`}
        ref={ledgerRef}
      >
        {visibleDays.length > 0 ? (
          <table className="ledger" style={{ minWidth: ledgerMinWidth }}>
            <colgroup>
              <col style={{ width: dayColumnWidth }} />
              <col />
              {trackers.map((tracker) => (
                <col
                  key={tracker.id}
                  style={{
                    width: tracker.kind === "mood" ? moodColumnWidth : trackerColumnWidth,
                  }}
                />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="day-column" scope="col">Day</th>
                <th className="moment-column" scope="col">Memorable moment</th>
                {trackers.map((tracker) => (
                  <th className="tracker-column" scope="col" key={tracker.id}>
                    <span className="tracker-label">
                      <span className="tracker-title">{tracker.name}</span>
                      <span className="tracker-type" aria-label={kindLabels[tracker.kind]}>
                        {kindMarks[tracker.kind]}
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleDays.map((day) => {
                const date = toDateKey(day);
                const isToday = date === todayKey;
                const isSelected = date === selectedDate;
                const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                return (
                  <tr
                    className={`ledger-row ${isToday ? "is-today" : ""} ${
                      isSelected ? "is-selected" : ""
                    } ${isWeekend ? "is-weekend" : ""}`}
                    data-date={date}
                    key={date}
                    onClick={() => setSelectedDate(date)}
                  >
                    <td
                      className="day-column day-cell"
                      aria-current={isToday ? "date" : undefined}
                      aria-label={new Intl.DateTimeFormat("en", { dateStyle: "full" }).format(day)}
                    >
                      <span className="day-number">{String(day.getDate()).padStart(2, "0")}</span>
                      <span className="day-name">
                        {new Intl.DateTimeFormat("en", { weekday: "narrow" }).format(day)}
                      </span>
                    </td>
                    <td className="moment-column">
                      <DraftTextInput
                        ariaLabel={`Memorable moment on ${date}`}
                        className="cell-input moment-input"
                        maxLength={200}
                        onCommit={(nextValue) => saveDailyNote(date, nextValue)}
                        placeholder={isToday ? "What will you remember?" : "—"}
                        value={noteMap.get(date) ?? ""}
                      />
                    </td>
                    {trackers.map((tracker) => (
                      <td key={tracker.id}>{renderTrackerCell(date, tracker)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty-ledger">No days are visible in this period.</div>
        )}
      </section>

      <footer className="statusbar" aria-live="polite">
        <span className={`status-message ${statusError ? "is-error" : ""}`}>{status}</span>
        <span className="save-state">
          {savedAt
            ? `Saved ${savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "Waiting for first entry"}
        </span>
      </footer>

      <dialog
        aria-labelledby="tracker-dialog-title"
        className="journal-dialog"
        ref={dialogRef}
        onClose={() => setTrackerDialogOpen(false)}
      >
        <div className="dialog-header">
          <h2 className="dialog-title" id="tracker-dialog-title">Manage trackers</h2>
          <button className="icon-button" onClick={() => setTrackerDialogOpen(false)} aria-label="Close">
            ×
          </button>
        </div>
        <form onSubmit={createTracker}>
          <div className="dialog-body">
            <div className="field-grid">
              <label className="field-label">
                Name
                <input
                  className="dialog-input"
                  maxLength={24}
                  placeholder="Meditation"
                  value={newTrackerName}
                  onChange={(event) => setNewTrackerName(event.target.value)}
                />
              </label>
              <label className="field-label">
                Type
                <select
                  className="dialog-select"
                  value={newTrackerKind}
                  onChange={(event) => setNewTrackerKind(event.target.value as TrackerKind)}
                >
                  {Object.entries(kindLabels).map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="tracker-list" aria-label="Active trackers">
              {trackers.map((tracker) => (
                <div
                  className={`tracker-list-row${
                    draggedTrackerId === tracker.id ? " is-dragging" : ""
                  }${
                    dropTarget?.id === tracker.id
                      ? ` is-drop-${dropTarget.position}`
                      : ""
                  }`}
                  key={tracker.id}
                  onDragOver={(event) => {
                    if (!draggedTrackerId || draggedTrackerId === tracker.id) return;
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const position =
                      event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
                    event.dataTransfer.dropEffect = "move";
                    setDropTarget({ id: tracker.id, position });
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceId =
                      event.dataTransfer.getData("text/plain") || draggedTrackerId;
                    if (!sourceId) return;
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const position =
                      event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
                    void reorderTrackers(sourceId, tracker.id, position);
                  }}
                >
                  <button
                    aria-label={`Reorder ${tracker.name}. Drag, or use the up and down arrow keys.`}
                    className="drag-handle"
                    draggable
                    title="Drag to reorder; arrow keys also work"
                    type="button"
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", tracker.id);
                      setDraggedTrackerId(tracker.id);
                    }}
                    onDragEnd={() => {
                      setDraggedTrackerId(null);
                      setDropTarget(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        moveTrackerWithKeyboard(tracker.id, -1);
                      }
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        moveTrackerWithKeyboard(tracker.id, 1);
                      }
                    }}
                  >
                    ⠿
                  </button>
                  <span className="tracker-name">{tracker.name}</span>
                  <span className="tracker-kind-label">{kindLabels[tracker.kind]}</span>
                  <button
                    aria-label={`Archive ${tracker.name}`}
                    className="archive-button"
                    type="button"
                    onClick={() => archiveTracker(tracker)}
                  >
                    Archive
                  </button>
                </div>
              ))}
              {archivedTrackers.length > 0 && (
                <div className="tracker-section-label">Archived</div>
              )}
              {archivedTrackers.map((tracker) => (
                <div className="tracker-list-row is-archived" key={tracker.id}>
                  <span className="drag-handle-placeholder" aria-hidden="true" />
                  <span className="tracker-name">{tracker.name}</span>
                  <span className="tracker-kind-label">{kindLabels[tracker.kind]}</span>
                  <button
                    aria-label={`Restore ${tracker.name}`}
                    className="restore-button"
                    type="button"
                    onClick={() => restoreTracker(tracker)}
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="dialog-footer">
            <button className="terminal-button" type="button" onClick={() => setTrackerDialogOpen(false)}>
              Close
            </button>
            <button className="terminal-button" type="submit" disabled={!newTrackerName.trim()}>
              Add tracker
            </button>
          </div>
        </form>
      </dialog>
      <CloudInteractionDialog interaction={cloudInteraction} />
    </main>
  );
}
