"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteStoredPlan,
  isSupabaseConfigured,
  isUnlocked,
  listPlans,
  lock,
  needsLoginEmail,
  unlock,
  upsertPlan,
} from "../lib/supabase";
import type { PlanWrite, StoredPlan } from "../lib/supabase";

type Tier = 1 | 2 | 3 | 4 | 5;
type Node = { id: string; text: string; x: number; y: number; color: string; tier: Tier };
type Link = { id: string; from: string; to: string };
type Zone = { id: string; title: string; x: number; y: number; w: number; h: number; color: string };
type Viewport = { x: number; y: number; zoom: number };
type Plan = { id: string; name: string; nodes: Node[]; links: Link[]; zones: Zone[]; updatedAt: number; viewport: Viewport };
type BackupFile = { app: "mindmap"; version: 1; exportedAt: string; plans: Plan[] };
type SyncState = "loading" | "pending" | "saving" | "saved" | "error" | "locked";
type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
type TierMetrics = { fontSize: number; fontWeight: number; border: number; minHeight: number; width: number; radius: number; padX: number };

const COLORS = ["#8074f8", "#27c2a7", "#f6b84c", "#ef6f87", "#59a9f8"];
const ZONE_COLORS = ["#8074f8", "#27c2a7", "#f6b84c", "#ef6f87", "#59a9f8", "#8fbf4c", "#c96fdf", "#e8753f"];
const RESIZE_DIRS: ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const THEME_KEY = "mindpages-theme";
const ACTIVE_PLAN_KEY = "mindpages-active-plan";
const PLAN_PAYLOAD_VERSION = 3;
const PLAN_LIMIT = 10;
const SYNC_DEBOUNCE_MS = 700;
const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
/**
 * Zoom jde klávesami na numerické klávesnici i na té hlavní.
 *
 * Mapujeme `code`, ne `key`. `code` popisuje fyzickou klávesu, takže je
 * nezávislý na rozvržení i na stavu NumLocku. `key` by nešel použít: při
 * vypnutém NumLocku posílá klávesa `+`/`-` v události `End`, takže by
 * zkratka tiše přestala fungovat právě v okamžiku, kdy uživatel NumLock
 * vypne. Vedlejší efekt je, že při NumLocku OFF chytíme i `End`, což
 * v aplikaci teď nic nedělá.
 *
 * Krok odpovídá tlačítkům v ovládání plátna, aby obě cesty zoomovaly stejně.
 */
const ZOOM_KEY_STEPS: Record<string, number> = {
  NumpadAdd: 1.2,
  NumpadSubtract: 1 / 1.2,
  Equal: 1.2,
  Minus: 1 / 1.2,
};
const MIN_ZONE_W = 180;
const MIN_ZONE_H = 120;
const DRAFT_ZONE_ID = "draft";

/* ------------------------------------------------------------------ tiery */

/**
 * Střed tieru musí být přesně dnešní uzel, aby starší plány nezmizely.
 * Ostatní tiemy se od něj odvíjejí. Rozptyl je záměrně velký: poměr šířky
 * krajních tierů je skoro 3:1, jinak se uzly na první pohled neliší.
 */
const DEFAULT_TIER: Tier = 3;
const TIERS: Tier[] = [1, 2, 3, 4, 5];
const TIER_METRICS: Record<Tier, TierMetrics> = {
  1: { fontSize: 10, fontWeight: 600, border: 1, minHeight: 42, width: 110, radius: 11, padX: 10 },
  2: { fontSize: 11, fontWeight: 700, border: 1, minHeight: 48, width: 140, radius: 13, padX: 14 },
  3: { fontSize: 12, fontWeight: 750, border: 1, minHeight: 56, width: 180, radius: 14, padX: 20 },
  4: { fontSize: 14, fontWeight: 800, border: 2, minHeight: 66, width: 260, radius: 18, padX: 24 },
  5: { fontSize: 17, fontWeight: 900, border: 2.5, minHeight: 80, width: 344, radius: 21, padX: 28 },
};

/** Cokoliv mimo 1–5, včetně chybějící hodnoty, spadne na prostřední tier. */
function normalizeTier(value: unknown): Tier {
  const rounded = Math.round(Number(value));
  return rounded >= 1 && rounded <= 5 ? (rounded as Tier) : DEFAULT_TIER;
}

function tierMetrics(tier: Tier): TierMetrics {
  return TIER_METRICS[tier];
}

function metricsOf(node: Node): TierMetrics {
  return tierMetrics(normalizeTier(node.tier));
}

/**
 * Šířka a výška uzlu podle tieru. Výška je minimální — uzel s dlouhým textem
 * je vyšší, a to bylo pravdou i před tify. Linky a členství v zóně pracují
 * s minimem, jinak by to vyžadovalo měřit layout při každém pohybu myši.
 */
function nodeWidth(node: Node): number {
  return metricsOf(node).width;
}

function nodeHeight(node: Node): number {
  return metricsOf(node).minHeight;
}

const starterPlan: Plan = {
  id: "starter",
  name: "Můj první plán",
  updatedAt: Date.now(),
  viewport: { ...DEFAULT_VIEWPORT },
  nodes: [
    { id: "n1", text: "Hlavní nápad", x: 390, y: 255, color: COLORS[0], tier: 5 },
    { id: "n2", text: "Co udělám jako první?", x: 665, y: 145, color: COLORS[1], tier: 3 },
    { id: "n3", text: "Kam se chci dostat", x: 690, y: 370, color: COLORS[2], tier: 2 },
  ],
  links: [
    { id: "l1", from: "n1", to: "n2" },
    { id: "l2", from: "n1", to: "n3" },
  ],
  // Fixní id, žádné uid() a žádné Date.now(): jinak by server a klient
  // vykreslily jiný obsah a vznikl by hydration mismatch. Zóna z1 je záměrně
  // širší, aby po zvětšení uzlu n1 na tier 5 pořád obsahovala i n2.
  zones: [
    { id: "z1", title: "První krok", x: 330, y: 100, w: 520, h: 240, color: ZONE_COLORS[0] },
    { id: "z2", title: "Možná později", x: 340, y: 350, w: 320, h: 160, color: ZONE_COLORS[4] },
  ],
};

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function clampZoom(zoom: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/* ------------------------------------------------------------------- zony */

/** Uzel patří do zóny, když jeho střed leží uvnitř obdélníku. */
function zoneContains(zone: Zone, node: Node) {
  const cx = node.x + nodeWidth(node) / 2;
  const cy = node.y + nodeHeight(node) / 2;
  return cx > zone.x && cx < zone.x + zone.w && cy > zone.y && cy < zone.y + zone.h;
}

/**
 * Zóna leží uvnitř jiné zóny, když její střed padá do obdélníku té druhé.
 * Stejné pravidlo jako u uzlů, jen se ptáme na střed zóny místo středu uzlu.
 */
function zoneContainsZone(outer: Zone, inner: Zone) {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx > outer.x && cx < outer.x + outer.w && cy > outer.y && cy < outer.y + outer.h;
}

/**
 * Hierarchie zón: kdo je v kom. Vrací mapu rodičů a mapu potomků.
 *
 * Podporuje jednu úroveň vnoření: zóna může být uvnitř jiné zóny, ale třetí
 * úroveň už ne. Rodič proto musí být zóna, která sama rodiče nemá.
 *
 * Zóny se mohou obepínat obousměrně (když jedna leží nad druhou a obě jsou
 * velké) a pak by cyklus neměl řešení. Řeší se to pořadím: zóny se zpracovávají
 * od největší plochy k nejmenší a rodičem smí být jen zóna, která už byla
 * zpracovaná. Větší zóna z cyklu je tak hotová dřív a může se stát rodičem
 * menší, což odpovídá tomu, co uživatel vidí — velký obdélník vypadá jako
 * kontejner, malý jako věc uvnitř.
 */
function buildZoneTree(zones: Zone[]): { parent: Map<string, string | null>; children: Map<string, string[]> } {
  const parent = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  for (const zone of zones) {
    parent.set(zone.id, null);
    children.set(zone.id, []);
  }

  // Od největší zóny k nejmenší.
  const ordered = [...zones].sort((a, b) => b.w * b.h - a.w * a.h);
  const processed = new Set<string>();

  for (const zone of ordered) {
    // Rodičem smí být jen zóna, která už prošla a sama je na vrcholu. Kdyby
    // rodič měl vlastního rodiče, vznikla by druhá úroveň vnoření.
    const containers = zones.filter(
      (other) => other.id !== zone.id
        && processed.has(other.id)
        && parent.get(other.id) === null
        && zoneContainsZone(other, zone),
    );
    if (containers.length === 0) {
      processed.add(zone.id);
      continue;
    }
    // Z více možností bereme největší, ta vypadá jako vnější kontejner.
    const container = containers.reduce((best, other) => (other.w * other.h > best.w * best.h ? other : best));
    parent.set(zone.id, container.id);
    children.get(container.id)?.push(zone.id);
    processed.add(zone.id);
  }

  return { parent, children };
}

/**
 * Hloubka zóny v hierarchii. Vnořená zóna má větší hloubku než její rodič.
 */
function zoneDepths(tree: { parent: Map<string, string | null> }): Map<string, number> {
  const depths = new Map<string, number>();
  for (const id of tree.parent.keys()) depths.set(id, 0);
  for (const id of tree.parent.keys()) {
    let depth = 0;
    let current = tree.parent.get(id) ?? null;
    // Cesta nemůže být nekonečná, protože vnoření je jen jedna úroveň.
    while (current !== null && depth < 8) {
      depth += 1;
      current = tree.parent.get(current) ?? null;
    }
    depths.set(id, depth);
  }
  return depths;
}

/**
 * Vlastník uzlu: zóna, ve které uzel leží, a je nejvnitřnější.
 *
 * Uzel vnořené zóny leží i v materské, ale patří do té vnořené. Kdyby se uzel
 * přiřadil k materské, vnoření by nemělo smysl a obsah vnořené zóny by se
 * hýbal dvakrát.
 */
function ownerZoneOf(zones: Zone[], depths: Map<string, number>, node: Node): Zone | null {
  let best: Zone | null = null;
  for (const zone of zones) {
    if (!zoneContains(zone, node)) continue;
    if (!best || (depths.get(zone.id) ?? 0) > (depths.get(best.id) ?? 0)) best = zone;
  }
  return best;
}

/** Západní a severní hrana posune i x/y, aby protější zůstala na místě. */
function resizeZone(zone: Zone, dir: ResizeDir, dx: number, dy: number): Zone {
  let { x, y, w, h } = zone;
  if (dir.includes("e")) w = Math.max(MIN_ZONE_W, zone.w + dx);
  if (dir.includes("w")) {
    w = Math.max(MIN_ZONE_W, zone.w - dx);
    x = zone.x + (zone.w - w);
  }
  if (dir.includes("s")) h = Math.max(MIN_ZONE_H, zone.h + dy);
  if (dir.includes("n")) {
    h = Math.max(MIN_ZONE_H, zone.h - dy);
    y = zone.y + (zone.h - h);
  }
  return { ...zone, x, y, w, h };
}

function isValidZone(value: unknown): value is Zone {
  if (!value || typeof value !== "object") return false;
  const zone = value as Partial<Zone>;
  return typeof zone.id === "string"
    && typeof zone.title === "string"
    && Number.isFinite(zone.x)
    && Number.isFinite(zone.y)
    && Number.isFinite(zone.w)
    && Number.isFinite(zone.h)
    && typeof zone.color === "string";
}

function isValidViewport(value: unknown): value is Viewport {
  if (!value || typeof value !== "object") return false;
  const viewport = value as Partial<Viewport>;
  return Number.isFinite(viewport.x) && Number.isFinite(viewport.y) && Number.isFinite(viewport.zoom) && viewport.zoom! > 0;
}

function normalizePlan(plan: Omit<Plan, "viewport" | "zones"> & { viewport?: Viewport; zones?: Zone[] }): Plan {
  const viewport = isValidViewport(plan.viewport)
    ? { x: plan.viewport.x, y: plan.viewport.y, zoom: clampZoom(plan.viewport.zoom) }
    : { ...DEFAULT_VIEWPORT };
  // Starší zálohy i plány v databázi zóny nemají. Chybějící je prázdná, ne chyba.
  const zones = Array.isArray(plan.zones) ? plan.zones.filter(isValidZone) : [];
  // Ani tier nemají. Doplní se prostřední, aby se jejich vzhled nezměnil.
  const nodes = Array.isArray(plan.nodes)
    ? plan.nodes.map((node) => (node && typeof node === "object" ? { ...node, tier: normalizeTier(node.tier) } : node))
    : [];
  return { ...plan, nodes, zones, updatedAt: Number.isFinite(plan.updatedAt) ? plan.updatedAt : Date.now(), viewport };
}

function isValidPlan(value: unknown): value is Plan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<Plan>;
  if (typeof plan.id !== "string" || typeof plan.name !== "string" || !Array.isArray(plan.nodes) || !Array.isArray(plan.links)) return false;
  // Tier je volitelný, aby prošly i staré zálohy. normalizePlan ho pak doplní.
  const nodesValid = plan.nodes.every((node) => node && typeof node.id === "string" && typeof node.text === "string" && Number.isFinite(node.x) && Number.isFinite(node.y) && typeof node.color === "string" && (node.tier === undefined || Number.isFinite(node.tier)));
  const nodeIds = new Set(plan.nodes.map((node) => node.id));
  const linksValid = plan.links.every((link) => link && typeof link.id === "string" && typeof link.from === "string" && typeof link.to === "string" && nodeIds.has(link.from) && nodeIds.has(link.to));
  // Zóny jsou volitelné, aby prošly i staré zálohy bez nich.
  const zonesValid = plan.zones === undefined || (Array.isArray(plan.zones) && plan.zones.every(isValidZone));
  return nodesValid && linksValid && zonesValid && (plan.viewport === undefined || isValidViewport(plan.viewport));
}

function freshCopy(plan: Plan): Plan {
  const nodeIds = new Map(plan.nodes.map((node) => [node.id, uid("node")]));
  const zones = normalizePlan(plan).zones;
  return {
    ...normalizePlan(plan),
    id: uid("plan"),
    updatedAt: Date.now(),
    nodes: plan.nodes.map((node) => ({ ...node, id: nodeIds.get(node.id)! })),
    links: plan.links.map((link) => ({ id: uid("link"), from: nodeIds.get(link.from)!, to: nodeIds.get(link.to)! })),
    zones: zones.map((zone) => ({ ...zone, id: uid("zone") })),
  };
}

/** Databázový řádek -> plán aplikace. Vadné kusy se zahodí, ne shodí UI. */
function fromStoredPlan(stored: StoredPlan): Plan | null {
  const candidate = {
    id: stored.id,
    name: stored.name,
    nodes: stored.payload?.nodes,
    links: stored.payload?.links,
    zones: stored.payload?.zones,
    viewport: stored.payload?.viewport,
    updatedAt: stored.updatedAt,
  };
  return isValidPlan(candidate) ? normalizePlan(candidate as Plan) : null;
}

function toStoredPlan(plan: Plan): PlanWrite {
  return {
    id: plan.id,
    name: plan.name,
    // Whitelist! Zapomeneš tady na zones, zóny se po každém načtení
    // tiše zahodí, bez chyby a bez varování.
    payload: { nodes: plan.nodes, links: plan.links, zones: plan.zones, viewport: plan.viewport },
    payloadVersion: PLAN_PAYLOAD_VERSION,
  };
}

const SYNC_LABELS: Record<SyncState, string> = {
  loading: "Načítám z databáze…",
  pending: "Neuložené změny…",
  saving: "Ukládám…",
  saved: "Uloženo v databázi",
  error: "Nepodařilo se uložit",
  locked: "Zamčeno",
};

export default function Home() {
  const [plans, setPlans] = useState<Plan[]>([starterPlan]);
  const [activeId, setActiveId] = useState(starterPlan.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  const [zoneMode, setZoneMode] = useState(false);
  const [draftZone, setDraftZone] = useState<Zone | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [pendingImport, setPendingImport] = useState<Plan[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Plan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [unlockInput, setUnlockInput] = useState("");
  const [unlockEmail, setUnlockEmail] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>("loading");
  const canvasRef = useRef<HTMLDivElement>(null);
  /**
   * Poslední pozice kurzoru nad plátnem, v souřadnicích plátna (tedy bez
   * posunu viewportu). Klávesový zoom míří sem, aby přibližoval pod kurzorem
   * stejně jako kolečko. `null` znamená, že kurzor na plátně ještě nebyl.
   */
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * Obsah schránky za Ctrl+C. Držíme ho v paměti, ne v systémní schránce,
   * protože systémová schránka bere text a my chceme objekt uzlu. Zóna a uzel
   * jdou v jedné zátěži, aby šlo kopírovat a vkládat obojí naráz.
   */
  const clipboardRef = useRef<{ nodes: Node[]; zones: Zone[] } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const interactionRef = useRef<
    | { type: "node"; id: string; startClientX: number; startClientY: number; startNodeX: number; startNodeY: number; zoom: number }
    | { type: "pan"; startClientX: number; startClientY: number; startX: number; startY: number }
    | { type: "zone"; id: string; startClientX: number; startClientY: number; startZoneX: number; startZoneY: number; zoom: number; carried: Map<string, { x: number; y: number }>; carriedZones: Map<string, { x: number; y: number }> }
    | { type: "zone-resize"; id: string; dir: ResizeDir; startClientX: number; startClientY: number; zone: Zone; zoom: number; childZones: Zone[] }
    | { type: "zone-create"; startWorldX: number; startWorldY: number; zoom: number }
    | null
  >(null);

  const plansRef = useRef<Plan[]>(plans);
  const syncRef = useRef<SyncState>(syncState);
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const flushTimerRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const configured = isSupabaseConfigured();

  // Zrcadlo pro asynchronni flush: ref se nesmi prepisovat během renderu, takže
  // se sem koupi po commitu. Debounce 700 ms stejně castaji cast pohnout.
  useEffect(() => {
    plansRef.current = plans;
  }, [plans]);

  function setSync(next: SyncState) {
    if (syncRef.current === next) return;
    syncRef.current = next;
    setSyncState(next);
  }

  const showNotice = useCallback((message: string) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 3200);
  }, []);

  useEffect(() => () => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
  }, []);

  /* ------------------------------------------------------------ ukladani */

  const flushPending = useCallback(async () => {
    const ids = Array.from(pendingIdsRef.current);
    pendingIdsRef.current = new Set();
    if (ids.length === 0) return;

    setSync("saving");
    try {
      for (const id of ids) {
        const plan = plansRef.current.find((item) => item.id === id);
        if (!plan) continue;
        await upsertPlan(toStoredPlan(plan));
      }
      setSync("saved");
    } catch (error) {
      setSync("error");
      const retry = new Set(pendingIdsRef.current);
      ids.forEach((id) => retry.add(id));
      pendingIdsRef.current = retry;
      showNotice(error instanceof Error ? error.message : "Uložení do databáze selhalo.");
    }
  }, [showNotice]);

  const queuePersist = useCallback((planId: string) => {
    pendingIdsRef.current.add(planId);
    setSync("pending");
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      void flushPending();
    }, SYNC_DEBOUNCE_MS);
  }, [flushPending]);

  /* -------------------------------------------------------------- start */

  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem(THEME_KEY);
      const next = savedTheme === "light" || savedTheme === "dark"
        ? savedTheme
        : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      setTheme(next);
      document.documentElement.dataset.theme = next;
    } catch { /* defaultni tema z index.html nechame bezi */ }
  }, []);

  const loadPlans = useCallback(async () => {
    // Cokoliv viselo ve fronte pred prihlasenim, uz neni aktualni: po nalozeni
    // z databaze je pravda tam.
    pendingIdsRef.current = new Set();
    const rows = await listPlans();
    const loaded = rows.map(fromStoredPlan).filter((plan): plan is Plan => plan !== null);

    if (loaded.length === 0) {
      // Databaze je zatim prazdna: zacne se vzorovym planem.
      setPlans([starterPlan]);
      setActiveId(starterPlan.id);
      try {
        await upsertPlan(toStoredPlan(starterPlan));
        setSync("saved");
      } catch {
        setSync("error");
      }
      return;
    }

    setPlans(loaded);
    let wanted: string | null = null;
    try {
      wanted = localStorage.getItem(ACTIVE_PLAN_KEY);
    } catch { /* pamet bez localStorage neni fatalni */ }
    setActiveId(wanted && loaded.some((plan) => plan.id === wanted) ? wanted : loaded[0].id);
    setSync("saved");
  }, []);

  useEffect(() => {
    if (!configured || !isUnlocked()) {
      setSync("locked");
      return;
    }

    let cancelled = false;
    setUnlocked(true);
    setSync("loading");

    loadPlans().catch((error) => {
      if (cancelled) return;
      // Když server odmítl obnovit přihlášení, klient session smazal.
      // V tom případě zpátky na zámek, ne chybovou hlášku nad prázdným plátnem.
      if (!isUnlocked()) {
        setUnlocked(false);
        setSync("locked");
        return;
      }
      setSync("error");
      showNotice(error instanceof Error ? error.message : "Plány se nepodařilo načíst.");
    });

    return () => {
      cancelled = true;
    };
  }, [configured, loadPlans, showNotice]);

  /* ------------------------------------------------------------- zamek */

  const handleUnlock = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setUnlockError(null);
    setUnlocking(true);
    try {
      const ok = await unlock(unlockInput, unlockEmail);
      if (!ok) {
        setUnlockError("Špatné heslo.");
        return;
      }
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : "Přihlášení selhalo.");
      return;
    } finally {
      setUnlocking(false);
    }
    setUnlocked(true);
    setUnlockInput("");
    setSync("loading");
    loadPlans().catch((error) => {
      if (!isUnlocked()) {
        setUnlocked(false);
        setSync("locked");
        return;
      }
      setSync("error");
      showNotice(error instanceof Error ? error.message : "Plány se nepodařilo načíst.");
    });
  }, [loadPlans, showNotice, unlockEmail, unlockInput]);

  const handleLock = useCallback(() => {
    pendingIdsRef.current = new Set();
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    lock();
    setUnlocked(false);
    setSync("locked");
    setSelectedId(null);
    setSelectedZoneId(null);
    setConnectFrom(null);
  }, []);

  /* ------------------------------------------------------------ plans */

  const activePlan = plans.find((plan) => plan.id === activeId) ?? plans[0];

  const updatePlan = useCallback((change: (plan: Plan) => Plan) => {
    setPlans((current) => current.map((plan) =>
      plan.id === activeId ? { ...change(plan), updatedAt: Date.now() } : plan
    ));
    queuePersist(activeId);
  }, [activeId, queuePersist]);

  const nodeMap = useMemo(() => new Map(activePlan.nodes.map((node) => [node.id, node])), [activePlan.nodes]);

  /**
   * Pořadí kreslení zón. Vnořená zóna musí být nad svou materskou, jinak by
   * ji materská překryla. Materská je v poli dřív, takže stačí seřadit podle
   * hloubky a vnořené vystoupí nahoru.
   */
  const zoneTree = useMemo(() => buildZoneTree(activePlan.zones), [activePlan.zones]);
  const zoneRenderOrder = useMemo(() => {
    const depths = zoneDepths(zoneTree);
    const all = [...activePlan.zones, ...(draftZone ? [draftZone] : [])];
    // Draft je vždy poslední, aby se kreslil nad vším.
    return all
      .map((zone, index) => ({ zone, index, depth: zone.id === DRAFT_ZONE_ID ? Infinity : (depths.get(zone.id) ?? 0) }))
      .sort((a, b) => (a.depth === b.depth ? a.index - b.index : a.depth - b.depth))
      .map((item) => item.zone);
  }, [activePlan.zones, draftZone, zoneTree]);

  function rememberActivePlan(id: string) {
    try {
      localStorage.setItem(ACTIVE_PLAN_KEY, id);
    } catch { /* pamat bez localStorage neni fatalni */ }
  }

  function addPlan() {
    if (plans.length >= PLAN_LIMIT) return;
    const plan: Plan = { id: uid("plan"), name: `Nový plán ${plans.length + 1}`, nodes: [], links: [], zones: [], updatedAt: Date.now(), viewport: { ...DEFAULT_VIEWPORT } };
    setPlans((current) => [...current, plan]);
    setActiveId(plan.id);
    rememberActivePlan(plan.id);
    setSelectedId(null);
    setSelectedZoneId(null);
    queuePersist(plan.id);
  }

  async function deletePlan(id: string) {
    if (plans.length === 1) return;
    const next = plans.filter((plan) => plan.id !== id);
    setPlans(next);
    pendingIdsRef.current.delete(id);
    if (activeId === id) {
      setActiveId(next[0].id);
      rememberActivePlan(next[0].id);
    }
    setPendingDelete(null);
    setSelectedId(null);
    setSelectedZoneId(null);
    showNotice("Plán byl smazán.");
    try {
      await deleteStoredPlan(id);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Smazání v databázi selhalo.");
    }
  }

  function addNode(x: number, y: number) {
    // Nový uzel začíná prostředním tierem, jeho rozměr tedy známe dopředu.
    const size = tierMetrics(DEFAULT_TIER);
    const node: Node = { id: uid("node"), text: "Nová myšlenka", x: x - size.width / 2, y: y - size.minHeight / 2, color: COLORS[activePlan.nodes.length % COLORS.length], tier: DEFAULT_TIER };
    updatePlan((plan) => ({ ...plan, nodes: [...plan.nodes, node] }));
    setSelectedId(node.id);
    setEditingId(node.id);
  }

  function handleCanvasDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || zoneMode) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    addNode((screenX - activePlan.viewport.x) / activePlan.viewport.zoom, (screenY - activePlan.viewport.y) / activePlan.viewport.zoom);
  }

  /** Klient -> world. Zoom se má po celou dobu dragu stejný, proto ho dostává zvencí. */
  function worldFromClient(clientX: number, clientY: number, zoom: number) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: (clientX - rect.left - activePlan.viewport.x) / zoom,
      y: (clientY - rect.top - activePlan.viewport.y) / zoom,
    };
  }

  function updateZone(id: string, patch: Partial<Zone>) {
    updatePlan((plan) => ({ ...plan, zones: plan.zones.map((zone) => (zone.id === id ? { ...zone, ...patch } : zone)) }));
  }

  function toggleZoneMode() {
    setZoneMode((current) => !current);
    setDraftZone(null);
    setConnectFrom(null);
  }

  function startZoneDrag(event: React.PointerEvent, zone: Zone) {
    if (event.button !== 0 || editingZoneId === zone.id || connectFrom) return;
    event.stopPropagation();

    // Kdo u zóně je, rozhodne se tady, jednou, a vezme si s sebou i jejich
    // pozice. Kdyby se členství i pozice počítaly až při každém pointermove,
    // uzly uvnitř by se postupně kumulativním posunem rozjely z obdélníku.
    //
    // Zóna si nese nejen uzly, které jsou v ní přímo, ale i vnořené zóny a
    // uzly uvnitř nich. Když táhne materská zóna, musí jet i to, co je
    // vnořeno dovnitř.
    const tree = buildZoneTree(activePlan.zones);
    const depths = zoneDepths(tree);
    const childIds = tree.children.get(zone.id) ?? [];
    const childZones = activePlan.zones.filter((item) => childIds.includes(item.id));

    const carried = new Map<string, { x: number; y: number }>();
    const carriedZones = new Map<string, { x: number; y: number }>();
    for (const child of childZones) {
      carriedZones.set(child.id, { x: child.x, y: child.y });
    }
    activePlan.nodes.forEach((node) => {
      // Uzel patří zóně, když v ní leží jeho střed. Vlastníkem je ta
      // nejvnitřnější, takže uzel ve vnořené zóně nepojede s materskou
      // dvakrát: jednou jako člen vnořené a podruhé jako člen materské.
      const owner = ownerZoneOf(activePlan.zones, depths, node);
      if (!owner) return;
      const isChild = childIds.includes(owner.id);
      if (owner.id === zone.id || isChild) {
        carried.set(node.id, { x: node.x, y: node.y });
      }
    });

    interactionRef.current = {
      type: "zone",
      id: zone.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startZoneX: zone.x,
      startZoneY: zone.y,
      zoom: activePlan.viewport.zoom,
      carried,
      carriedZones,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startZoneResize(event: React.PointerEvent, zone: Zone, dir: ResizeDir) {
    if (event.button !== 0 || connectFrom) return;
    event.stopPropagation();
    // Vnořené zóny si bereme ze snapshotu, jinak by se při každém pointermove
    // počítaly znovu a uchýlily by se.
    const tree = buildZoneTree(activePlan.zones);
    const childIds = tree.children.get(zone.id) ?? [];
    const childZones = activePlan.zones.filter((item) => childIds.includes(item.id));
    interactionRef.current = {
      type: "zone-resize",
      id: zone.id,
      dir,
      startClientX: event.clientX,
      startClientY: event.clientY,
      zone: { ...zone },
      zoom: activePlan.viewport.zoom,
      childZones: childZones.map((child) => ({ ...child })),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function selectNode(id: string) {
    if (connectFrom && connectFrom !== id) {
      const exists = activePlan.links.some((link) => link.from === connectFrom && link.to === id);
      if (!exists) updatePlan((plan) => ({ ...plan, links: [...plan.links, { id: uid("link"), from: connectFrom, to: id }] }));
      setConnectFrom(null);
    }
    setSelectedId(id);
    setSelectedZoneId(null);
  }

  function startDrag(event: React.PointerEvent, node: Node) {
    if (event.button !== 0 || editingId === node.id || connectFrom) return;
    event.stopPropagation();
    interactionRef.current = {
      type: "node",
      id: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startNodeX: node.x,
      startNodeY: node.y,
      zoom: activePlan.viewport.zoom,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.target !== event.currentTarget || connectFrom) return;

    // V režimu kreslení místo panu vzniká obdélník.
    if (zoneMode) {
      const world = worldFromClient(event.clientX, event.clientY, activePlan.viewport.zoom);
      if (!world) return;
      interactionRef.current = { type: "zone-create", startWorldX: world.x, startWorldY: world.y, zoom: activePlan.viewport.zoom };
      setDraftZone({ id: DRAFT_ZONE_ID, title: "", x: world.x, y: world.y, w: 0, h: 0, color: ZONE_COLORS[activePlan.zones.length % ZONE_COLORS.length] });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    interactionRef.current = {
      type: "pan",
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: activePlan.viewport.x,
      startY: activePlan.viewport.y,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function movePointer(event: React.PointerEvent) {
    // Pozici si pamatujeme vždy, i když zrovna nic netáhneme. Klávesový zoom
    // se k ní potřebuje přiblížit a kurzor přitom bývá nad plátnem v klidu.
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) pointerRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };

    const interaction = interactionRef.current;
    if (!interaction) return;

    if (interaction.type === "pan") {
      const x = interaction.startX + event.clientX - interaction.startClientX;
      const y = interaction.startY + event.clientY - interaction.startClientY;
      updatePlan((plan) => ({ ...plan, viewport: { ...plan.viewport, x, y } }));
      return;
    }

    // Každá větev musí skončit returnem. Bez toho by cokoliv, co není "pan",
    // propadlo do větve pro uzly a každý pohyb myší by zapisoval do databáze.
    if (interaction.type === "node") {
      const x = interaction.startNodeX + (event.clientX - interaction.startClientX) / interaction.zoom;
      const y = interaction.startNodeY + (event.clientY - interaction.startClientY) / interaction.zoom;
      updatePlan((plan) => ({ ...plan, nodes: plan.nodes.map((node) => node.id === interaction.id ? { ...node, x, y } : node) }));
      return;
    }

    if (interaction.type === "zone") {
      const dx = (event.clientX - interaction.startClientX) / interaction.zoom;
      const dy = (event.clientY - interaction.startClientY) / interaction.zoom;
      updatePlan((plan) => {
        if (!plan.zones.some((zone) => zone.id === interaction.id)) return plan;
        // Všechno se počítá ze snapshotu z pointerdown, nikdy z živých pozic.
        // Přičítat celou deltu k už posunutému místu by pokaždé znovu rozjelo
        // zónu i uzly uvnitř, a ty by odletěly ven.
        const x = interaction.startZoneX + dx;
        const y = interaction.startZoneY + dy;
        return {
          ...plan,
          // Vnořené zóny jedou spolu s materskou. Zóna, která se právě táhne,
          // má vlastní pozici ze snapshotu.
          zones: plan.zones.map((zone) => {
            if (zone.id === interaction.id) return { ...zone, x, y };
            const start = interaction.carriedZones.get(zone.id);
            return start ? { ...zone, x: start.x + dx, y: start.y + dy } : zone;
          }),
          nodes: plan.nodes.map((node) => {
            const start = interaction.carried.get(node.id);
            return start ? { ...node, x: start.x + dx, y: start.y + dy } : node;
          }),
        };
      });
      return;
    }

    if (interaction.type === "zone-resize") {
      const dx = (event.clientX - interaction.startClientX) / interaction.zoom;
      const dy = (event.clientY - interaction.startClientY) / interaction.zoom;
      updatePlan((plan) => {
        // Tady musí být interaction.zone ze snapshotu. resizeZone by s živou
        // zónou začínal pokaždé od jiné hodnoty a rozměr by ujížděl.
        const resized = resizeZone(interaction.zone, interaction.dir, dx, dy);

        // Vnořená zóna si drží svou velikost, jen se posune, aby zůstala
        // uvnitř rodiče. Když se rodič zmenší pod její rozměr, vnořená se
        // zarovná k jeho levému hornímu rohu a část přeteče ven. To je v
        // pořádku, je to jen vizuální překryv a dá se srovnat tažením.
        const children = interaction.childZones.map((child) => {
          const x = child.w <= resized.w
            ? Math.min(Math.max(child.x, resized.x), resized.x + resized.w - child.w)
            : resized.x;
          const y = child.h <= resized.h
            ? Math.min(Math.max(child.y, resized.y), resized.y + resized.h - child.h)
            : resized.y;
          return { id: child.id, x, y };
        });
        const childById = new Map(children.map((child) => [child.id, child]));

        return {
          ...plan,
          zones: plan.zones.map((zone) => {
            if (zone.id === interaction.id) return resized;
            const child = childById.get(zone.id);
            return child ? { ...zone, x: child.x, y: child.y } : zone;
          }),
        };
      });
      return;
    }

    const world = worldFromClient(event.clientX, event.clientY, interaction.zoom);
    if (!world) return;
    setDraftZone((current) => (current ? {
      ...current,
      x: Math.min(interaction.startWorldX, world.x),
      y: Math.min(interaction.startWorldY, world.y),
      w: Math.abs(world.x - interaction.startWorldX),
      h: Math.abs(world.y - interaction.startWorldY),
    } : current));
  }

  function finishPointer() {
    if (draftZone) {
      // Omylem kliknutí by vytvořilo zónu 0x0, takže malý obdélník zahodíme.
      if (draftZone.w >= MIN_ZONE_W && draftZone.h >= MIN_ZONE_H) {
        const zone: Zone = { ...draftZone, id: uid("zone"), title: "Nová zóna" };
        updatePlan((plan) => ({ ...plan, zones: [...plan.zones, zone] }));
        setSelectedId(null);
        setSelectedZoneId(zone.id);
        setEditingZoneId(zone.id);
      }
      setDraftZone(null);
      setZoneMode(false);
    }
    interactionRef.current = null;
    setIsPanning(false);
  }

  const zoomAt = useCallback((screenX: number, screenY: number, factor: number) => {
    updatePlan((plan) => {
      const zoom = clampZoom(plan.viewport.zoom * factor);
      const worldX = (screenX - plan.viewport.x) / plan.viewport.zoom;
      const worldY = (screenY - plan.viewport.y) / plan.viewport.zoom;
      return { ...plan, viewport: { x: screenX - worldX * zoom, y: screenY - worldY * zoom, zoom } };
    });
  }, [updatePlan]);

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const factor = Math.exp(-event.deltaY * 0.0015);
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
  }

  const zoomFromCenter = useCallback((factor: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(rect.width / 2, rect.height / 2, factor);
  }, [zoomAt]);

  /**
   * Zoom pod kurzorem, stejně jako kolečko myši.
   *
   * Kurzor musí být fakt nad plátnem. Spoléhat na `pointerleave` nejde
   * spolehlivě, protože pozice zůstává zapsaná i po přesunu myši na ovládací
   * prvky dole, a zoom by pak mířil do prázdna. Proto pozici ověříme proti
   * aktuálním hranicím. Stejná kontrola vyřeší i odscrollování stránky, kdy se
   * plátno posune pod stálou pozicí kurzoru.
   */
  const zoomAtPointer = useCallback((factor: number) => {
    const pointer = pointerRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!pointer || !rect || pointer.x < 0 || pointer.y < 0 || pointer.x > rect.width || pointer.y > rect.height) {
      zoomFromCenter(factor);
      return;
    }
    zoomAt(pointer.x, pointer.y, factor);
  }, [zoomAt, zoomFromCenter]);

  function fitGraph() {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Zóny musí být v hranicích taky, jinak se ořízne něco, co už na plátně je.
    const boxes = [
      ...activePlan.nodes.map((node) => ({ x: node.x, y: node.y, w: nodeWidth(node), h: nodeHeight(node) })),
      ...activePlan.zones.map((zone) => ({ x: zone.x, y: zone.y, w: zone.w, h: zone.h })),
    ];
    if (boxes.length === 0) {
      updatePlan((plan) => ({ ...plan, viewport: { ...DEFAULT_VIEWPORT } }));
      return;
    }
    const minX = Math.min(...boxes.map((box) => box.x));
    const minY = Math.min(...boxes.map((box) => box.y));
    const maxX = Math.max(...boxes.map((box) => box.x + box.w));
    const maxY = Math.max(...boxes.map((box) => box.y + box.h));
    const contentWidth = Math.max(1, maxX - minX);
    const contentHeight = Math.max(1, maxY - minY);
    const padding = 80;
    const zoom = clampZoom(Math.min(1, (rect.width - padding * 2) / contentWidth, (rect.height - padding * 2) / contentHeight));
    const x = (rect.width - contentWidth * zoom) / 2 - minX * zoom;
    const y = (rect.height - contentHeight * zoom) / 2 - minY * zoom;
    updatePlan((plan) => ({ ...plan, viewport: { x, y, zoom } }));
  }

  const deleteSelected = useCallback(() => {
    // Vybraná zóna má přednost před uzlem, jinak by šlo mazat dvě věci najednou.
    if (selectedZoneId) {
      // Uzly uvnitř zůstávají, mizí jen rámeček.
      updatePlan((plan) => ({ ...plan, zones: plan.zones.filter((zone) => zone.id !== selectedZoneId) }));
      setSelectedZoneId(null);
      setEditingZoneId(null);
      return;
    }
    if (!selectedId) return;
    updatePlan((plan) => ({
      ...plan,
      nodes: plan.nodes.filter((node) => node.id !== selectedId),
      links: plan.links.filter((link) => link.from !== selectedId && link.to !== selectedId),
    }));
    setSelectedId(null);
    // Kdyby uzel zároveň byl zdrojem propojování, ukazoval by connectFrom na
    // neexistující uzel. Další klik by pak vytvořil hranu s visícím `from`,
    // isValidPlan by ji odmítl a celý plán by se po reloadu zahodil.
    setConnectFrom((current) => (current === selectedId ? null : current));
  }, [updatePlan, selectedId, selectedZoneId]);

  /**
   * Ctrl+C nad vybraným uzlem nebo zónou. Bez výběru necháme událost
   * prohlížeči, ať se dá kopírovat vybraný text na stránce.
   */
  const copySelected = useCallback(() => {
    const node = selectedId ? activePlan.nodes.find((item) => item.id === selectedId) : null;
    const zone = selectedZoneId ? activePlan.zones.find((item) => item.id === selectedZoneId) : null;
    if (!node && !zone) return;

    // Bereme celý objekt, takže se překopíruje i text, barva a tier.
    clipboardRef.current = {
      nodes: node ? [{ ...node }] : [],
      zones: zone ? [{ ...zone }] : [],
    };
  }, [selectedId, selectedZoneId, activePlan.nodes, activePlan.zones]);

  /**
   * Ctrl+V vloží schránku pod kurzor. Vazby (`links`) se záměrně nekopírují,
   * takže vložený uzel přichází bez hran. Kdyby se kopírovaly, odkazovaly by
   * na původní uzly a po jejich smazání by zůstaly viset naprázdno.
   *
   * Každý vložený objekt dostane nové ID. Bez toho by vznikly dva uzly se
   * shodným ID, což by rozbilo výběr i ukládání.
   */
  const pasteClipboard = useCallback(() => {
    const copied = clipboardRef.current;
    if (!copied || (copied.nodes.length === 0 && copied.zones.length === 0)) return;

    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Kurzor má přednost. Když je mimo plátno, vloží se do středu plochy,
    // aby vložení fungovalo i bez pohnutí myší.
    const pointer = pointerRef.current;
    const inside = pointer !== null && pointer.x >= 0 && pointer.y >= 0 && pointer.x <= rect.width && pointer.y <= rect.height;
    const screenX = inside ? pointer.x : rect.width / 2;
    const screenY = inside ? pointer.y : rect.height / 2;

    // Klíčové je dělit viewportem, jinak by při zoomu 25 % uzel přistál jinam
    // než pod kurzor.
    const worldX = (screenX - activePlan.viewport.x) / activePlan.viewport.zoom;
    const worldY = (screenY - activePlan.viewport.y) / activePlan.viewport.zoom;

    // Jeden posun pro všechny vložené objekty, aby si uzel a zóna zachovaly
    // vzájemné umístění. Uzel přitom přistane pod kurzorem svým středem,
    // samotná zóna levým horním rohem.
    let offsetX: number;
    let offsetY: number;
    if (copied.nodes.length > 0) {
      offsetX = worldX - copied.nodes[0].x - nodeWidth(copied.nodes[0]) / 2;
      offsetY = worldY - copied.nodes[0].y - nodeHeight(copied.nodes[0]) / 2;
    } else {
      offsetX = worldX - copied.zones[0].x;
      offsetY = worldY - copied.zones[0].y;
    }

    const newNodes = copied.nodes.map((node) => ({ ...node, id: uid("node"), x: node.x + offsetX, y: node.y + offsetY }));
    const newZones = copied.zones.map((zone) => ({ ...zone, id: uid("zone"), x: zone.x + offsetX, y: zone.y + offsetY }));

    updatePlan((plan) => ({ ...plan, nodes: [...plan.nodes, ...newNodes], zones: [...plan.zones, ...newZones] }));
    // Nové objekty se stanou výběrem, aby je šlo hned posunout. Textové pole
    // neotevíráme, jinak by nešlo Ctrl+V opakovat za sebou.
    setSelectedId(newNodes[0]?.id ?? null);
    setSelectedZoneId(newZones[0]?.id ?? null);
    setConnectFrom(null);
  }, [activePlan.viewport, updatePlan]);

  /* ------------------------------------------------------------ klavesnica */

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const step = ZOOM_KEY_STEPS[event.code];

      // Zoom jde klávesami i během editace, takže ho řešíme dřív než Delete.
      if (step !== undefined) {
        // Když je fokus v textovém poli, klávesa patří textu. Bez tohoto
        // by každé minus v názvu uzlu oddálilo plátno.
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
        if (editingId !== null || editingZoneId !== null) return;
        // Otevřený dialog nebo zamčená aplikace mají přednost.
        if (pendingImport !== null || pendingDelete !== null || !unlocked) return;

        // Ctrl a Meta necháváme prohlížeči, ať má Ctrl +/- zoom prohlížeče
        // nadále smysl. Alt by na numerické klávesnici nikdy nebylo potřeba.
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        event.preventDefault();
        // Držení klávesy posílá keydown opakovaně a při kroku 1.2 by to
        // vymetlo plátno během jedné vteřiny. Stačí jedno stisknutí.
        if (event.repeat) return;
        zoomAtPointer(step);
        return;
      }

      // Kopírování a vkládání řešíme dřív než Delete, protože jinak by se
      // vkládalo i během editace textu.
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const lower = event.key.toLowerCase();

        // Ctrl+C bez výběru propustíme prohlížeči, ať kopíruje vybraný text.
        if (lower === "c") {
          if (selectedId === null && selectedZoneId === null) return;
          const target = event.target as HTMLElement | null;
          if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
          if (editingId !== null || editingZoneId !== null) return;
          if (pendingImport !== null || pendingDelete !== null || !unlocked) return;

          event.preventDefault();
          if (event.repeat) return;
          copySelected();
          return;
        }

        if (lower === "v") {
          // Textové pole má vkládání vlastní, tam se nesahá.
          const target = event.target as HTMLElement | null;
          if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
          if (editingId !== null || editingZoneId !== null) return;
          if (pendingImport !== null || pendingDelete !== null || !unlocked) return;

          // Událost blokujeme vždy, i s prázdnou schránkou. Kdyby ji prohlížeč
          // zpracoval, při odkazu v systémové schránce by nás přesměroval na
          // ten odkaz a plán by se ztratil.
          event.preventDefault();
          if (event.repeat) return;
          pasteClipboard();
          return;
        }
      }

      if (event.key !== "Delete") return;

      // Když je fokus v textovém poli, klávesa patří textu, ne grafu. Prohlížeč
      // ji zpracuje sám a smaže znak nebo znaky. To platí i pro titulek zóny.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

      // Druhá pojistka: editace je zároveň stav, takže to platí i kdyby fokus
      // zrovna ležel jinde.
      if (editingId !== null || editingZoneId !== null) return;
      // Otevřený dialog nebo zamčená aplikace mají přednost.
      if (pendingImport !== null || pendingDelete !== null || !unlocked) return;
      // Bez výběru není co mazat.
      if (selectedId === null && selectedZoneId === null) return;

      event.preventDefault();
      deleteSelected();
    }

    window.addEventListener("keydown", onKeyDown);
    // Cleanup je povinný, jinak by při hot reloadu zůstalo několik listenerů
    // a jedno stisknutí Delete by smazalo několik věcí.
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copySelected, deleteSelected, editingId, editingZoneId, pasteClipboard, pendingImport, pendingDelete, unlocked, selectedId, selectedZoneId, zoomAtPointer]);

  function changeColor() {
    if (!selectedId) return;
    updatePlan((plan) => ({ ...plan, nodes: plan.nodes.map((node) => {
      if (node.id !== selectedId) return node;
      const next = (COLORS.indexOf(node.color) + 1) % COLORS.length;
      return { ...node, color: COLORS[next] };
    }) }));
  }

  function changeTier(tier: Tier) {
    if (!selectedId) return;
    updatePlan((plan) => ({ ...plan, nodes: plan.nodes.map((node) => (node.id === selectedId ? { ...node, tier } : node)) }));
  }

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch { /* tema bez localStorage neprezije reload, neni to fatalni */ }
  }

  function safeFileName(name: string) {
    return name.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plan";
  }
  function exportPlans(scope: "all" | "current") {
    const exportedPlans = scope === "all" ? plans : [activePlan];
    const backup: BackupFile = { app: "mindmap", version: 1, exportedAt: new Date().toISOString(), plans: exportedPlans };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = scope === "all" ? `mindpages-zaloha-${new Date().toISOString().slice(0, 10)}.json` : `${safeFileName(activePlan.name)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showNotice(scope === "all" ? "Záloha všech plánů byla stažena." : "Aktuální plán byl stažen.");
  }

  async function readImport(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const possiblePlans = Array.isArray(parsed) ? parsed : (parsed as Partial<BackupFile>)?.plans;
      if (!Array.isArray(possiblePlans) || possiblePlans.length === 0 || !possiblePlans.every(isValidPlan)) throw new Error("invalid");
      setPendingImport(possiblePlans.map((plan) => freshCopy(normalizePlan(plan))));
    } catch {
      showNotice("Soubor není platná záloha aplikace MindPages.");
    }
  }

  function finishImport(mode: "merge" | "replace") {
    if (!pendingImport) return;
    let next: Plan[];
    if (mode === "replace") {
      next = pendingImport.slice(0, PLAN_LIMIT);
    } else {
      const freeSlots = Math.max(0, PLAN_LIMIT - plans.length);
      if (freeSlots === 0) {
        setPendingImport(null);
        showNotice(`Všech ${PLAN_LIMIT} míst je obsazených. Některý plán nejdřív smaž.`);
        return;
      }
      next = [...plans, ...pendingImport.slice(0, freeSlots)];
    }
    const nextActiveId = mode === "replace" ? next[0].id : next[plans.length].id;
    setPlans(next);
    setActiveId(nextActiveId);
    rememberActivePlan(nextActiveId);
    setSelectedId(null);
    setSelectedZoneId(null);
    setPendingImport(null);
    const added = mode === "replace" ? next.length : next.length - plans.length;
    showNotice(`${added} ${added === 1 ? "plán byl importován" : "plány byly importovány"}.`);

    if (mode === "replace") {
      plansRef.current
        .filter((plan) => !next.some((item) => item.id === plan.id))
        .forEach((plan) => {
          void deleteStoredPlan(plan.id).catch(() => {
            // Mazani starych radku nechame na dalsim pokusu, import tim neni blokovany.
          });
        });
    }
    pendingIdsRef.current = new Set(next.map((plan) => plan.id));
    // flushPending běží hned, takže zrcadlo musí ukazovat na nové plány; efekt
    // výše se totiž ještě neprovedl.
    plansRef.current = next;
    void flushPending();
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">M</span><div><strong>MindPages</strong><small>prostor pro myšlenky</small></div></div>
        <div className="plans-heading"><span>MOJE PLÁNY</span><span>{plans.length}/{PLAN_LIMIT}</span></div>
        <div className="plan-list">
          {plans.map((plan, index) => (
            <button key={plan.id} className={`plan-item ${plan.id === activeId ? "active" : ""}`} onClick={() => { setActiveId(plan.id); rememberActivePlan(plan.id); setSelectedId(null); setSelectedZoneId(null); }}>
              <span className="plan-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="plan-copy"><strong>{plan.name}</strong><small>{plan.nodes.length} myšlenek</small></span>
              {plans.length > 1 && <span className="plan-delete" role="button" aria-label={`Smazat plán ${plan.name}`} onClick={(e) => { e.stopPropagation(); setPendingDelete(plan); }}>×</span>}
            </button>
          ))}
        </div>
        <button className="new-plan" onClick={addPlan} disabled={plans.length >= PLAN_LIMIT}>＋ Nový plán</button>
        <div className="sidebar-tip"><span>TIP</span><p>Tažením pozadí se pohybuješ po plátně. Kolečkem přibližuješ.</p></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <input className="plan-title" value={activePlan.name} aria-label="Název plánu" onChange={(e) => updatePlan((plan) => ({ ...plan, name: e.target.value }))} />
            <div className="save-state" data-state={syncState}><span /> {SYNC_LABELS[syncState]}</div>
            {unlocked && (
              <div className="account-row">
                <span className="account-email">Zamčeno heslem</span>
                <button type="button" className="link-button" onClick={handleLock}>Zamknout</button>
              </div>
            )}
          </div>
          <div className="tools">
            <div className="backup-tools">
              <button className="tool" onClick={() => exportPlans("all")} title="Stáhnout všech deset plánů">⇩ <span>Export vše</span></button>
              <button className="tool tool-compact" onClick={() => exportPlans("current")} title="Stáhnout jen tento plán">1</button>
              <button className="tool" onClick={() => importRef.current?.click()} title="Načíst plány ze souboru">⇧ <span>Import</span></button>
              <input ref={importRef} className="file-input" type="file" accept="application/json,.json" onChange={readImport} />
            </div>
            <button className="tool theme-toggle" onClick={toggleTheme} title={theme === "dark" ? "Přepnout na světlý režim" : "Přepnout na tmavý režim"} aria-label={theme === "dark" ? "Přepnout na světlý režim" : "Přepnout na tmavý režim"}>
              <span className="theme-icon" aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span><span>{theme === "dark" ? "Světlý" : "Tmavý"}</span>
            </button>
            <button className={connectFrom ? "tool active" : "tool"} disabled={!selectedId} onClick={() => setConnectFrom(connectFrom ? null : selectedId)} title="Propojit vybranou myšlenku">↗ <span>{connectFrom ? "Klikni na cíl" : "Propojit"}</span></button>
            {selectedId && (
              <div className="tiers" role="group" aria-label="Důležitost myšlenky">
                {TIERS.map((tier) => (
                  <button
                    key={tier}
                    className={`tier-pill tier-pill-${tier}`}
                    aria-pressed={normalizeTier(activePlan.nodes.find((node) => node.id === selectedId)?.tier) === tier}
                    title={`Tier ${tier}`}
                    onClick={() => changeTier(tier)}
                  >
                    {tier}
                  </button>
                ))}
              </div>
            )}
            <button className={zoneMode ? "tool active" : "tool"} onClick={toggleZoneMode} title="Vyznačit obdélník na plátně">▭ <span>{zoneMode ? "Taž obdélník" : "Nová zóna"}</span></button>
            {selectedZoneId ? (
              <div className="swatches" role="group" aria-label="Barva zóny">
                {ZONE_COLORS.map((color) => (
                  <button
                    key={color}
                    className="swatch"
                    style={{ background: color }}
                    aria-label={`Barva zóny ${color}`}
                    aria-pressed={activePlan.zones.find((zone) => zone.id === selectedZoneId)?.color === color}
                    onClick={() => updateZone(selectedZoneId, { color })}
                  />
                ))}
              </div>
            ) : (
              <button className="tool" disabled={!selectedId} onClick={changeColor} title="Změnit barvu">● <span>Barva</span></button>
            )}
            <button className="tool danger" disabled={!selectedId && !selectedZoneId} onClick={deleteSelected} title={selectedZoneId ? "Smazat zónu, uzly zůstanou" : "Smazat myšlenku"}>⌫ <span>Smazat</span></button>
          </div>
        </header>

        <div
          className={`canvas ${connectFrom ? "connecting" : ""} ${isPanning ? "panning" : ""} ${zoneMode ? "drawing" : ""}`}
          ref={canvasRef}
          onDoubleClick={handleCanvasDoubleClick}
          onPointerDown={startPan}
          onPointerMove={movePointer}
          onPointerUp={finishPointer}
          onPointerCancel={finishPointer}
          onWheel={handleWheel}
          onClick={(e) => { if (e.target === e.currentTarget) { setSelectedId(null); setSelectedZoneId(null); setConnectFrom(null); } }}
        >
          <div
            className="grid"
            style={{
              backgroundPosition: `${activePlan.viewport.x}px ${activePlan.viewport.y}px`,
              backgroundSize: `${22 * activePlan.viewport.zoom}px ${22 * activePlan.viewport.zoom}px`,
            }}
          />
          <div className="scene" style={{ transform: `translate(${activePlan.viewport.x}px, ${activePlan.viewport.y}px) scale(${activePlan.viewport.zoom})` }}>
            <svg className="links" aria-hidden="true">
              <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
              {activePlan.links.map((link) => {
                const from = nodeMap.get(link.from); const to = nodeMap.get(link.to);
                if (!from || !to) return null;
                return <line key={link.id} x1={from.x + nodeWidth(from) / 2} y1={from.y + nodeHeight(from) / 2} x2={to.x + nodeWidth(to) / 2} y2={to.y + nodeHeight(to) / 2} markerEnd="url(#arrow)" />;
              })}
            </svg>
            {/* Zóny leží nad hranami a pod uzly: výplň je průhledná, ať je
                vidět graf, ale titulek a hrany zůstávají čitelné. */}
            {zoneRenderOrder.map((zone) => {
              const isDraft = zone.id === DRAFT_ZONE_ID;
              const isSelected = zone.id === selectedZoneId;
              const isNested = !isDraft && zoneTree.parent.get(zone.id) !== null && zoneTree.parent.get(zone.id) !== undefined;
              return (
                <div
                  key={zone.id}
                  className={`zone ${isSelected ? "selected" : ""} ${isDraft ? "draft" : ""} ${isNested ? "nested" : ""}`}
                  style={{ left: zone.x, top: zone.y, width: zone.w, height: zone.h, "--zone-color": zone.color } as React.CSSProperties}
                >
                  <div
                    className="zone-title"
                    onPointerDown={isDraft ? undefined : (e) => startZoneDrag(e, zone)}
                    onClick={isDraft ? undefined : (e) => { e.stopPropagation(); setSelectedZoneId(zone.id); setSelectedId(null); }}
                    onDoubleClick={isDraft ? undefined : (e) => { e.stopPropagation(); setEditingZoneId(zone.id); }}
                  >
                    {editingZoneId === zone.id ? (
                      <input
                        autoFocus
                        value={zone.title}
                        onChange={(e) => updateZone(zone.id, { title: e.target.value })}
                        onBlur={() => setEditingZoneId(null)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditingZoneId(null); }}
                      />
                    ) : <span>{zone.title}</span>}
                  </div>
                  {!isDraft && RESIZE_DIRS.map((dir) => (
                    <span key={dir} className={`zone-handle zone-handle-${dir}`} onPointerDown={(e) => startZoneResize(e, zone, dir)} />
                  ))}
                </div>
              );
            })}
            {activePlan.nodes.map((node) => {
              const tier = normalizeTier(node.tier);
              const size = tierMetrics(tier);
              return (
                <div
                  key={node.id}
                  // Třída tier-N je tu i kvůli testům: tady nejsou DOM testy,
                  // jen vykreslené HTML, které se dá prohledat.
                  className={`node tier-${tier} ${selectedId === node.id ? "selected" : ""} ${connectFrom === node.id ? "source" : ""}`}
                  style={{
                    left: node.x,
                    top: node.y,
                    width: size.width,
                    "--node-color": node.color,
                    "--node-size": `${size.fontSize}px`,
                    "--node-weight": size.fontWeight,
                    "--node-line": `${size.border}px`,
                    "--node-min": `${size.minHeight}px`,
                    "--node-radius": `${size.radius}px`,
                    "--node-pad": `${size.padX}px`,
                  } as React.CSSProperties}
                  onPointerDown={(e) => startDrag(e, node)}
                  onClick={(e) => { e.stopPropagation(); selectNode(node.id); }}
                  onDoubleClick={(e) => { e.stopPropagation(); setEditingId(node.id); }}
                >
                  <span className="node-dot" />
                  {editingId === node.id ? (
                    <input autoFocus value={node.text} onChange={(e) => updatePlan((plan) => ({ ...plan, nodes: plan.nodes.map((item) => item.id === node.id ? { ...item, text: e.target.value } : item) }))} onBlur={() => setEditingId(null)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditingId(null); }} />
                  ) : <span>{node.text}</span>}
                  <span className="node-handle" />
                </div>
              );
            })}
          </div>
          {activePlan.nodes.length === 0 && activePlan.zones.length === 0 && <div className="empty-state"><div>＋</div><h2>Začni první myšlenkou</h2><p>Dvojklikni kamkoliv do plochy.</p></div>}
          <div className="viewport-controls" aria-label="Ovládání plátna">
            <button onClick={() => zoomFromCenter(1 / 1.2)} title="Oddálit" aria-label="Oddálit">−</button>
            <span>{Math.round(activePlan.viewport.zoom * 100)} %</span>
            <button onClick={() => zoomFromCenter(1.2)} title="Přiblížit" aria-label="Přiblížit">＋</button>
            <i />
            <button className="fit-button" onClick={fitGraph} title="Zobrazit celý graf">⌗ <b>Celý graf</b></button>
          </div>
          <div className="canvas-help"><kbd>2× klik</kbd> nová myšlenka <i /> <kbd>▭ zóna</kbd> obdélník <i /> <kbd>táhni pozadí</kbd> posun <i /> <kbd>⌫</kbd> smaž <i /> <kbd>Ctrl C/V</kbd> kopíruj/vlož <i /> <kbd>kolečko</kbd> nebo <kbd>+/−</kbd> zoom</div>
        </div>
      </section>

      {pendingImport && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingImport(null); }}>
          <section className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <div className="import-icon">⇧</div>
            <h2 id="import-title">Importovat {pendingImport.length} {pendingImport.length === 1 ? "plán" : "plány"}</h2>
            <p>Chceš je přidat k současným plánům, nebo současné plány úplně nahradit?</p>
            <div className="import-actions">
              <button className="dialog-button secondary" onClick={() => setPendingImport(null)}>Zrušit</button>
              <button className="dialog-button secondary" onClick={() => finishImport("merge")}>Sloučit</button>
              <button className="dialog-button primary" onClick={() => finishImport("replace")}>Nahradit vše</button>
            </div>
            <small>V aplikaci může být maximálně {PLAN_LIMIT} plánů.</small>
          </section>
        </div>
      )}
      {pendingDelete && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingDelete(null); }}>
          <section className="import-dialog delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description">
            <div className="delete-icon">!</div>
            <h2 id="delete-title">Smazat plán „{pendingDelete.name}“?</h2>
            <p id="delete-description">Opravdu chceš tento plán smazat? Přijdeš o celý graf, všechny myšlenky i jejich propojení. Tuto akci nelze vrátit zpět.</p>
            <div className="import-actions">
              <button className="dialog-button secondary" autoFocus onClick={() => setPendingDelete(null)}>Ponechat plán</button>
              <button className="dialog-button danger" onClick={() => void deletePlan(pendingDelete.id)}>Ano, smazat</button>
            </div>
          </section>
        </div>
      )}
      {notice && <div className="notice" role="status">✓ {notice}</div>}

      {!unlocked && (
        <div className="auth-gate">
          <form className="auth-card" role="dialog" aria-modal="true" aria-labelledby="auth-title" onSubmit={handleUnlock}>
            <div className="auth-mark">M</div>
            <h2 id="auth-title">MindPages</h2>

            {!configured ? (
              <>
                <p>Plány se ukládají do databáze, aby se daly otevřít z libovolného zařízení.</p>
                <div className="auth-setup">
                  <strong>Chybí připojení k Supabase.</strong>
                  <span>Soubor <code>.env.local</code> je schválně v <code>.gitignore</code>, takže ho git nikdy neposílá a na novém počítači chybí. Zkopíruj ho ze staršího počítače, nebo vytvoř nový podle <code>.env.example</code>: <code>VITE_SUPABASE_URL</code> a <code>VITE_SUPABASE_ANON_KEY</code>.</span>
                  <span>E-mail účtu se nastavuje v <code>VITE_AUTH_EMAIL</code>. Když chybí, formulář se na něj zeptá.</span>
                </div>
              </>
            ) : (
              <>
                <p>Zadej heslo a otevří plány.</p>
                {needsLoginEmail() && (
                  <label className="auth-field">
                    <span>E-mail</span>
                    <input type="email" autoComplete="username" value={unlockEmail} onChange={(e) => setUnlockEmail(e.target.value)} />
                  </label>
                )}
                <label className="auth-field">
                  <span>Heslo</span>
                  <input type="password" autoFocus autoComplete="current-password" value={unlockInput} onChange={(e) => setUnlockInput(e.target.value)} />
                </label>
                {unlockError && <p className="auth-error" role="alert">{unlockError}</p>}
                <button type="submit" className="dialog-button primary auth-submit" disabled={unlocking}>
                  {unlocking ? "Přihlašuji…" : "Odemknout"}
                </button>
                {syncState === "loading" && <small className="auth-hint">Načítám plány…</small>}
              </>
            )}
          </form>
        </div>
      )}

    </main>
  );
}
