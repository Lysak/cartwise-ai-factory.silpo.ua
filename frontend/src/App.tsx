import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Badge, Button, Card, Combobox, Container, Group, Image, List, Modal, Stack, Text, TextInput, Title, useCombobox } from '@mantine/core';
import { IconArrowLeft, IconBrandTelegram, IconHeart, IconHeartFilled, IconHistory, IconLogout, IconSearch } from '@tabler/icons-react';
// @ts-expect-error Vite resolves CSS modules at build time.
import classes from './cartwise-app.module.css';

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData?: string; ready?: () => void; expand?: () => void } };
  }
}

type BootstrapResponse =
  | { status: 'authenticated'; csrfToken: string; silpoStatus: 'active' | 'reauth_required' | 'missing'; preferredSilpoBranchId: string | null; telegramConnected?: boolean }
  | { status: 'oauth_required'; authorizationUrl: string };

type AuthenticatedState = {
  csrfToken: string;
  silpoStatus: 'active' | 'reauth_required' | 'missing';
  preferredSilpoBranchId: string | null;
  telegramConnected: boolean;
};

type AppState = 'checking' | 'session-checking' | 'outside-telegram' | 'error' | 'authenticated' | 'discovery-complete' | 'discovery-failed' | 'identity-probe-complete' | 'identity-probe-failed';
type Screen = 'branch-picker' | 'search' | 'detail' | 'my-items' | 'history';

type BranchSummary = {
  silpoBranchId: string;
  city: string | null;
  address: string | null;
};

type ProductSummary = {
  slug: string;
  externalProductId: string | null;
  name: string | null;
  brandTitle: string | null;
  image: string | null;
  price: number | null;
  oldPrice: number | null;
  stock: number | null;
  available: boolean | null;
};

type ProductDetail = {
  product: ProductSummary;
  attributes: Record<string, string>;
  analysis: ProductAnalysis | null;
  trackingId: string | null;
};

type TrackingItem = {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  branchId: string;
  currentPrice: string | null;
};

type NotificationItem = {
  id: string;
  type: string;
  productName: string;
  price: string | null;
  oldPrice: string | null;
  readAt: string | null;
};

type HistoryItem = {
  price: string | null;
  oldPrice: string | null;
  observedAt: string;
};

type ProductComponentKey = 'energy' | 'protein' | 'fat' | 'carbohydrates' | 'ingredients' | 'organic' | 'allergens';
type ProductAnalysis = {
  score: number | null;
  confidence: 'low' | 'medium' | 'high' | null;
  factors: string[];
  components: { key: ProductComponentKey; label: string; value: string | null }[];
  unavailableComponents: ProductComponentKey[];
  algorithmVersion: 'v2';
  sourceHash: string;
};

type SilpoErrorCode = 'SILPO_REAUTH_REQUIRED' | 'BRANCH_REQUIRED';

class SilpoResponseError extends Error {
  constructor(readonly code: SilpoErrorCode | null) {
    super('Silpo request failed');
  }
}

async function readSilpoErrorCode(response: Response): Promise<SilpoErrorCode | null> {
  if (response.status !== 409) return null;

  try {
    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null || typeof (data as Record<string, unknown>).code !== 'string') return null;
    const code = (data as Record<string, unknown>).code;
    return code === 'SILPO_REAUTH_REQUIRED' || code === 'BRANCH_REQUIRED' ? code : null;
  } catch {
    return null;
  }
}

function isBootstrapResponse(value: unknown): value is BootstrapResponse {
  if (typeof value !== 'object' || value === null) return false;

  const response = value as Record<string, unknown>;
  if (response.status === 'oauth_required') return typeof response.authorizationUrl === 'string';

  return response.status === 'authenticated'
    && typeof response.csrfToken === 'string'
    && (response.silpoStatus === 'active' || response.silpoStatus === 'reauth_required' || response.silpoStatus === 'missing')
    && (typeof response.preferredSilpoBranchId === 'string' || response.preferredSilpoBranchId === null)
    && (response.telegramConnected === undefined || typeof response.telegramConnected === 'boolean');
}

function isAuthorizationResponse(value: unknown): value is { authorizationUrl: string } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).authorizationUrl === 'string';
}

function isDeepLinkResponse(value: unknown): value is { deepLink: string } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).deepLink === 'string';
}

function isBranchesResponse(value: unknown): value is { branches: BranchSummary[] } {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as Record<string, unknown>).branches)) return false;
  return (value as { branches: unknown[] }).branches.every((branch) => {
    if (typeof branch !== 'object' || branch === null) return false;
    const row = branch as Record<string, unknown>;
    return typeof row.silpoBranchId === 'string' && row.silpoBranchId.trim().length > 0
      && (row.city === null || typeof row.city === 'string')
      && (row.address === null || typeof row.address === 'string');
  });
}

const safeNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const safeString = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const safeDecimal = (value: unknown): string | null => typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value.trim()) ? value.trim() : null;

function toProductSummary(value: unknown): ProductSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const slug = safeString(row.slug);
  const externalProductId = safeString(row.externalProductId);
  const name = safeString(row.name);
  if (!slug || slug.length > 256 || /[\s/]/.test(slug) || (externalProductId !== null && externalProductId.length > 256) || (name !== null && name.length > 512)) return null;
  const image = safeString(row.image);
  return {
    slug,
    externalProductId,
    name,
    brandTitle: safeString(row.brandTitle),
    image: image && /^https?:\/\//i.test(image) ? image : null,
    price: safeNumber(row.price),
    oldPrice: safeNumber(row.oldPrice),
    stock: safeNumber(row.stock),
    available: typeof row.available === 'boolean' ? row.available : null,
  };
}

function isProductSearchResponse(value: unknown): value is { products: ProductSummary[] } {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as Record<string, unknown>).products)) return false;
  return (value as { products: unknown[] }).products.every((product) => toProductSummary(product) !== null);
}

function toTrackingItem(value: unknown): TrackingItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = safeString(row.id);
  const name = safeString(row.name);
  const externalProductId = safeString(row.externalProductId);
  const slug = safeString(row.slug);
  const branchId = safeString(row.branchId);
  if (!id || !name || !externalProductId || !slug || !branchId || (row.status !== 'active' && row.status !== 'disabled')) return null;
  const currentPrice = row.currentPrice === null ? null : safeDecimal(row.currentPrice);
  if (row.currentPrice !== null && currentPrice === null) return null;
  const imageUrl = safeString(row.imageUrl);
  return { id, name, slug, imageUrl: imageUrl && /^https:\/\//i.test(imageUrl) ? imageUrl : null, branchId, currentPrice };
}

function toNotificationItem(value: unknown): NotificationItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.product !== 'object' || row.product === null || Array.isArray(row.product)) return null;
  const product = row.product as Record<string, unknown>;
  const id = safeString(row.id);
  const type = safeString(row.type);
  const productName = safeString(product.name);
  const productSlug = safeString(product.slug);
  const externalProductId = safeString(product.externalProductId);
  const createdAt = safeString(row.createdAt);
  const readAt = row.readAt === null ? null : safeString(row.readAt);
  if (!id || !type || !productName || !productSlug || !externalProductId || !createdAt || (row.readAt !== null && !readAt)) return null;
  const price = row.price === null ? null : safeDecimal(row.price);
  const oldPrice = row.oldPrice === null ? null : safeDecimal(row.oldPrice);
  if ((row.price !== null && price === null) || (row.oldPrice !== null && oldPrice === null)) return null;
  return { id, type, productName, price, oldPrice, readAt };
}

function toHistoryItem(value: unknown): HistoryItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const observedAt = safeString(row.observedAt);
  if (!observedAt) return null;
  const price = row.price === null ? null : safeDecimal(row.price);
  const oldPrice = row.oldPrice === null ? null : safeDecimal(row.oldPrice);
  if ((row.price !== null && price === null) || (row.oldPrice !== null && oldPrice === null)) return null;
  return { price, oldPrice, observedAt };
}

function isItemsResponse(value: unknown): value is { items: unknown[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>).items);
}

type PersonalBenefit = { active: boolean; description: string; expiresAt: string | null; limitText: string | null; rewardText: string | null };

function isPersonalBenefitsReport(value: unknown): value is { outcome: 'available' | 'unavailable'; benefits: PersonalBenefit[] } {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (row.outcome === 'available' || row.outcome === 'unavailable') && Array.isArray(row.benefits)
    && row.benefits.every((benefit) => typeof benefit === 'object' && benefit !== null
      && typeof (benefit as Record<string, unknown>).active === 'boolean'
      && typeof (benefit as Record<string, unknown>).description === 'string');
}

function notificationLabel(type: string): string {
  if (type === 'price_drop') return 'Зниження ціни';
  if (type === 'lowest_7d') return 'Найнижча ціна за 7 днів';
  if (type === 'lowest_30d') return 'Найнижча ціна за 30 днів';
  if (type === 'lowest_90d') return 'Найнижча ціна за 90 днів';
  if (type === 'all_time_low') return 'Історичний мінімум';
  return 'Зміна ціни';
}

function confidenceLabel(value: ProductAnalysis['confidence']): string {
  if (value === 'high') return 'висока впевненість';
  if (value === 'medium') return 'середня впевненість';
  if (value === 'low') return 'низька впевненість';
  return 'немає даних';
}

function observedDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('uk-UA', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

const hiddenAttributeKeys = new Set(['accesstoken', 'authorization', 'branchid', 'companyid', 'jsonrpc', 'loyalty', 'profile', 'refreshtoken', 'silpoexternalid', 'token']);

function safeAttributes(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, raw]) =>
    !hiddenAttributeKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, '')) && typeof raw === 'string' && raw.trim()
  ).slice(0, 32));
}

function isProductDetailResponse(value: unknown): value is ProductDetail {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return toProductSummary(row.product) !== null && (row.attributes === undefined || (typeof row.attributes === 'object' && row.attributes !== null && !Array.isArray(row.attributes)));
}

function trackingIdFromDetail(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

const productComponentKeys: ProductComponentKey[] = ['energy', 'protein', 'fat', 'carbohydrates', 'ingredients', 'organic', 'allergens'];
const productComponentLabels: Record<ProductComponentKey, string> = {
  energy: 'Енергія', protein: 'Білки', fat: 'Жири', carbohydrates: 'Вуглеводи',
  ingredients: 'Склад / E-добавки', organic: 'Органічність', allergens: 'Алергени'
};
const productComponentValuePatterns: Record<Exclude<ProductComponentKey, 'allergens'>, RegExp> = {
  energy: /^\d+(?:\.\d+)? кКал$/,
  protein: /^\d+(?:\.\d+)? г$/,
  fat: /^\d+(?:\.\d+)? г$/,
  carbohydrates: /^\d+(?:\.\d+)? г$/,
  ingredients: /^(?:Склад є, E-добавок не знайдено|\d+ E-добавок)$/,
  organic: /^(?:Органічний|Не органічний)$/,
};

const safeFactor = /^[+-]\d+: (?:енергетична цінність \d+(?:\.\d+)? кКал|білки \d+(?:\.\d+)? г|жири \d+(?:\.\d+)? г|вуглеводи \d+(?:\.\d+)? г|\d+ E-добавок у складі|підтверджено органічний товар)$/;

function toProductAnalysis(value: unknown): ProductAnalysis | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const score = safeNumber(row.score);
  const confidence = row.confidence;
  if (Object.keys(row).sort().join() !== 'algorithmVersion,components,confidence,factors,score,sourceHash,unavailableComponents'
    || (row.score === null) !== (confidence === null)
    || (row.score !== null && (score === null || !Number.isInteger(score) || score < 0 || score > 100))
    || !(confidence === null || confidence === 'low' || confidence === 'medium' || confidence === 'high')
    || !Array.isArray(row.factors)
    || !row.factors.every((item) => typeof item === 'string' && safeFactor.test(item))
    || !Array.isArray(row.components)
    || row.components.length !== productComponentKeys.length
    || !row.components.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
    || row.algorithmVersion !== 'v2'
    || typeof row.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceHash)
    || !Array.isArray(row.unavailableComponents)
    || row.unavailableComponents.length > productComponentKeys.length
    || !row.unavailableComponents.every((key) => typeof key === 'string' && productComponentKeys.includes(key as ProductComponentKey))) return null;

  const components = row.components as Record<string, unknown>[];
  const keys = components.map((item) => item.key);
  if (!keys.every((key) => typeof key === 'string' && productComponentKeys.includes(key as ProductComponentKey))
    || new Set(keys).size !== productComponentKeys.length
    || !productComponentKeys.every((key) => keys.includes(key))
    || new Set(row.unavailableComponents).size !== row.unavailableComponents.length
    || JSON.stringify(row.unavailableComponents) !== JSON.stringify(components.filter((item) => item.value === null).map((item) => item.key))) return null;
  const available = productComponentKeys.length - row.unavailableComponents.length;
  const expectedConfidence = available === 0 ? null : available <= 2 ? 'low' : available <= 4 ? 'medium' : 'high';
  if (confidence !== expectedConfidence || (row.score === null) !== (available === 0)) return null;
  return components.every((item) => {
    const key = item.key as ProductComponentKey;
    if (Object.keys(item).sort().join() !== 'key,label,value' || item.label !== productComponentLabels[key]) return false;
    if (item.value === null) return true;
    if (typeof item.value !== 'string') return false;
    return key === 'allergens' ? item.value === 'Є дані від Сільпо' : productComponentValuePatterns[key].test(item.value);
  }) ? {
    score: row.score as number | null,
    confidence: confidence as ProductAnalysis['confidence'],
    factors: [...row.factors] as string[],
    components: components.map((item) => ({ key: item.key as ProductComponentKey, label: item.label as string, value: item.value as string | null })),
    unavailableComponents: [...row.unavailableComponents] as ProductComponentKey[],
    algorithmVersion: 'v2',
    sourceHash: row.sourceHash as string,
  } : null;
}

async function fetchBranches(query = ''): Promise<BranchSummary[]> {
  const response = await fetch(`/api/silpo/branches?q=${encodeURIComponent(query)}`, { credentials: 'same-origin' });
  if (!response.ok) throw new SilpoResponseError(await readSilpoErrorCode(response));
  const data: unknown = await response.json();
  if (!isBranchesResponse(data)) throw new Error('Invalid branches response');
  return data.branches;
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ slug?: string; trackingId?: string }>();
  const searchParams = new URLSearchParams(location.search);
  const sharedSearchQuery = location.pathname === '/' ? searchParams.get('q')?.trim() ?? '' : '';
  const isSharedSearchUrl = sharedSearchQuery.length > 0 && [...searchParams.keys()].every((key) => key === 'q');
  // A plain browser visit/reload of any app route (not just '/') should be
  // treated the same as the historical "clean root" case: attempt session
  // restore, and treat a 401 there as a normal logged-out state rather than
  // an error. Query-param callback flows (?silpo=connected etc.) still only
  // apply at the root path, matching the existing behavior below.
  const isCleanRoot = (window.location.pathname === '/'
    || window.location.pathname === '/favourites'
    || window.location.pathname.startsWith('/product/')
    || window.location.pathname.startsWith('/history/'))
    && (window.location.search === '' || isSharedSearchUrl) && window.location.hash === '';
  const [state, setState] = useState<AppState>(() => {
    const silpo = new URLSearchParams(window.location.search).get('silpo');
    if (silpo === 'connected') return 'session-checking';
    if (silpo === 'failed') return 'error';
    const identityProbe = new URLSearchParams(window.location.search).get('silpo_identity_probe');
    if (identityProbe === 'complete') return 'identity-probe-complete';
    if (identityProbe === 'failed') return 'identity-probe-failed';
    const discovery = new URLSearchParams(window.location.search).get('silpo_discovery');
    if (discovery === 'complete') return 'discovery-complete';
    if (discovery === 'failed') return 'discovery-failed';
    return window.Telegram?.WebApp?.initData ? 'checking' : isCleanRoot ? 'session-checking' : 'outside-telegram';
  });
  const [authenticated, setAuthenticated] = useState<AuthenticatedState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [query, setQuery] = useState(sharedSearchQuery);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<ProductDetail | null>(null);
  const [trackingItems, setTrackingItems] = useState<TrackingItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [selectedTrackingItem, setSelectedTrackingItem] = useState<TrackingItem | null>(null);
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [branchPickerReturnToSearch, setBranchPickerReturnToSearch] = useState(false);
  const [branchQuery, setBranchQuery] = useState('');
  const [branchOptions, setBranchOptions] = useState<BranchSummary[]>([]);
  const [branchQueryBusy, setBranchQueryBusy] = useState(false);
  const [branchQueryError, setBranchQueryError] = useState<string | null>(null);
  const branchQueryVersion = useRef(0);
  const branchCombobox = useCombobox({ onDropdownClose: () => branchCombobox.resetSelectedOption() });
  const [productOptions, setProductOptions] = useState<ProductSummary[]>([]);
  const [productQueryBusy, setProductQueryBusy] = useState(false);
  const [productQueryError, setProductQueryError] = useState<string | null>(null);
  const productQueryVersion = useRef(0);
  const skipInitialProductSuggestions = useRef(sharedSearchQuery.length > 0);
  const productCombobox = useCombobox({ onDropdownClose: () => productCombobox.resetSelectedOption() });
  const [benefitDiscoveryStatus, setBenefitDiscoveryStatus] = useState<'idle' | 'running' | 'complete' | 'unavailable'>('idle');
  const [personalBenefits, setPersonalBenefits] = useState<PersonalBenefit[]>([]);
  const [favouriteSubscriptionId, setFavouriteSubscriptionId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<TrackingItem | null>(null);
  const bootstrapped = useRef(false);

  // The route is the source of truth for which screen to show; branch-picker
  // is a modal-like overlay shown atop any route, not a route of its own.
  const screen: Screen = branchPickerOpen
    ? 'branch-picker'
    : params.slug
      ? 'detail'
      : location.pathname === '/favourites'
        ? 'my-items'
        : params.trackingId
          ? 'history'
          : 'search';

  const moveToReauthorization = () => {
    setAuthenticated((current) => current ? { ...current, silpoStatus: 'reauth_required' } : current);
    setScreenError(null);
  };

  const loadBranches = useCallback(() => {
    setScreenBusy(true);
    void fetchBranches()
      .then(setBranches)
      .catch((error: unknown) => {
        if (error instanceof SilpoResponseError && error.code === 'SILPO_REAUTH_REQUIRED') {
          setAuthenticated((current) => current ? { ...current, silpoStatus: 'reauth_required' } : current);
          setScreenError(null);
          return;
        }
        setScreenError(error instanceof SilpoResponseError && error.code === 'BRANCH_REQUIRED'
          ? 'Спочатку оберіть магазин.'
          : 'Не вдалося завантажити магазини. Спробуйте ще раз.');
      })
      .finally(() => setScreenBusy(false));
  }, []);

  useEffect(() => {
    const normalizedQuery = branchQuery.trim();
    const version = ++branchQueryVersion.current;
    if (normalizedQuery.length < 2) {
      branchCombobox.closeDropdown();
      return;
    }

    branchCombobox.openDropdown();
    const timeout = window.setTimeout(() => {
      void fetchBranches(normalizedQuery)
        .then((nextBranches) => {
          if (version !== branchQueryVersion.current) return;
          setBranchOptions(nextBranches);
        })
        .catch(async (error: unknown) => {
          if (version !== branchQueryVersion.current) return;
          if (error instanceof SilpoResponseError && error.code === 'SILPO_REAUTH_REQUIRED') {
            setAuthenticated((current) => current ? { ...current, silpoStatus: 'reauth_required' } : current);
            return;
          }
          setBranchQueryError('Не вдалося знайти магазини. Спробуйте ще раз.');
        })
        .finally(() => {
          if (version === branchQueryVersion.current) setBranchQueryBusy(false);
        });
    }, 400);
    return () => window.clearTimeout(timeout);
  // Combobox methods are stable; keeping the store out avoids restarting the debounce on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchQuery]);

  useEffect(() => {
    if (skipInitialProductSuggestions.current) {
      skipInitialProductSuggestions.current = false;
      return;
    }

    const normalizedQuery = query.trim();
    const version = ++productQueryVersion.current;
    if (normalizedQuery.length < 2) {
      setProductOptions([]);
      setProductQueryBusy(false);
      productCombobox.closeDropdown();
      return;
    }
    productCombobox.openDropdown();
    setProductQueryBusy(true);
    const timeout = window.setTimeout(() => {
      void fetch(`/api/silpo/products?${new URLSearchParams({ q: normalizedQuery, limit: '5' }).toString()}`, { credentials: 'same-origin' })
        .then(async (response) => {
          if (!response.ok) throw new SilpoResponseError(await readSilpoErrorCode(response));
          const data: unknown = await response.json();
          if (!isProductSearchResponse(data)) throw new Error('Invalid product suggestions');
          if (version === productQueryVersion.current) setProductOptions(data.products.map(toProductSummary).filter((product): product is ProductSummary => product !== null));
        })
        .catch((error: unknown) => {
          if (version !== productQueryVersion.current) return;
          if (error instanceof SilpoResponseError && error.code === 'SILPO_REAUTH_REQUIRED') {
            moveToReauthorization();
            return;
          }
          setProductQueryError('Не вдалося знайти товари. Спробуйте ще раз.');
        })
        .finally(() => { if (version === productQueryVersion.current) setProductQueryBusy(false); });
    }, 400);
    return () => window.clearTimeout(timeout);
  // Combobox methods are stable; keep the debounce keyed only to the query.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const updateBranchQuery = (value: string) => {
    setBranchQuery(value);
    setBranchOptions([]);
    setBranchQueryError(null);
    setBranchQueryBusy(value.trim().length >= 2);
  };

  // Loads product detail for `slug` into state; returns whether it succeeded.
  // Used both for the interactive "open product" click and to hydrate a
  // /product/:slug deep link/reload.
  const loadProductBySlug = async (slug: string): Promise<boolean> => {
    if (screenBusy) return false;

    setScreenBusy(true);
    setScreenError(null);
    try {
      const response = await fetch(`/api/silpo/products/${encodeURIComponent(slug)}`, { credentials: 'same-origin' });
      if (!response.ok) {
        const errorCode = await readSilpoErrorCode(response);
        if (errorCode === 'SILPO_REAUTH_REQUIRED') moveToReauthorization();
        else {
          setScreenError(errorCode === 'BRANCH_REQUIRED' ? 'Спочатку оберіть магазин.' : 'Не вдалося відкрити товар. Спробуйте ще раз.');
          if (errorCode === 'BRANCH_REQUIRED') setBranchPickerOpen(true);
        }
        return false;
      }
      const data: unknown = await response.json();
      if (!isProductDetailResponse(data)) {
        setScreenError('Не вдалося відкрити товар. Спробуйте ще раз.');
        return false;
      }
      setSelectedProduct({ product: toProductSummary(data.product) as ProductSummary, attributes: safeAttributes(data.attributes), analysis: toProductAnalysis(data.analysis), trackingId: trackingIdFromDetail(data.trackingId) });
      setFavouriteSubscriptionId(trackingIdFromDetail(data.trackingId));
      return true;
    } catch {
      setScreenError('Не вдалося відкрити товар. Спробуйте ще раз.');
      return false;
    } finally {
      setScreenBusy(false);
    }
  };

  // Loads tracked items and notifications; used both for the interactive
  // "Мої товари" click and to hydrate a /favourites deep link/reload.
  const loadMyItems = async () => {
    // No `!authenticated` check here: callers (the "Мої товари" click, gated
    // by an already-authenticated render, and the bootstrap deep-link hydrator)
    // are both only reachable once auth is established. Checking `authenticated`
    // here previously broke /favourites deep-link/reload hydration, because the
    // bootstrap effect calls this synchronously right after `setAuthenticated`,
    // while this closure still sees the pre-update (null) value.
    if (screenBusy) return;

    setScreenBusy(true);
    setScreenError(null);
    try {
      const [trackingResponse, notificationsResponse] = await Promise.all([
        fetch('/api/tracking', { credentials: 'same-origin' }),
        fetch('/api/notifications', { credentials: 'same-origin' }),
      ]);
      if (!trackingResponse.ok || !notificationsResponse.ok) throw new Error('My items request failed');
      const trackingData: unknown = await trackingResponse.json();
      const notificationsData: unknown = await notificationsResponse.json();
      if (!isItemsResponse(trackingData) || !isItemsResponse(notificationsData)) throw new Error('Invalid my items response');
      setTrackingItems(trackingData.items.map(toTrackingItem).filter((item): item is TrackingItem => item !== null));
      setNotifications(notificationsData.items.map(toNotificationItem).filter((item): item is NotificationItem => item !== null));
    } catch {
      setScreenError('Не вдалося завантажити мої товари. Спробуйте ще раз.');
    } finally {
      setScreenBusy(false);
    }
  };

  // Deep link / reload of /history/:trackingId: the interactive flow (see
  // openHistory below) already has the TrackingItem in hand, but a fresh
  // load only has its id, so resolve it from the tracked-items list first.
  const loadHistoryById = async (trackingId: string) => {
    if (screenBusy) return;

    setScreenBusy(true);
    setScreenError(null);
    try {
      const trackingResponse = await fetch('/api/tracking', { credentials: 'same-origin' });
      if (!trackingResponse.ok) throw new Error('Tracking lookup failed');
      const trackingData: unknown = await trackingResponse.json();
      if (!isItemsResponse(trackingData)) throw new Error('Invalid tracking response');
      const items = trackingData.items.map(toTrackingItem).filter((entry): entry is TrackingItem => entry !== null);
      const item = items.find((entry) => entry.id === trackingId);
      if (!item) throw new Error('Tracking item not found');
      // Populate trackingItems too, so navigating back to /favourites from a
      // direct /history/:trackingId link doesn't show a false-empty list.
      setTrackingItems(items);
      setSelectedTrackingItem(item);
      setHistoryItems([]);

      const historyResponse = await fetch(`/api/tracking/${encodeURIComponent(item.id)}/history`, { credentials: 'same-origin' });
      if (!historyResponse.ok) throw new Error('History request failed');
      const historyData: unknown = await historyResponse.json();
      if (!isItemsResponse(historyData)) throw new Error('Invalid history response');
      setHistoryItems(historyData.items.map(toHistoryItem).filter((history): history is HistoryItem => history !== null));
    } catch {
      setScreenError('Не вдалося завантажити історію. Спробуйте ще раз.');
    } finally {
      setScreenBusy(false);
    }
  };

  // Runs once at bootstrap: opens the branch picker overlay when no store is
  // saved yet, otherwise hydrates whatever screen the current URL points at
  // (so a deep link / reload restores the right screen instead of a blank one).
  const runProductSearch = async (rawQuery: string, updateUrl = false) => {
    const trimmedQuery = rawQuery.trim();
    if (!trimmedQuery || screenBusy) return;

    if (updateUrl) navigate({ pathname: '/', search: `?${new URLSearchParams({ q: trimmedQuery }).toString()}` });
    setScreenBusy(true);
    setScreenError(null);
    try {
      const params = new URLSearchParams({ q: trimmedQuery, limit: '20' });
      const response = await fetch(`/api/silpo/products?${params.toString()}`, { credentials: 'same-origin' });
      if (!response.ok) {
        const errorCode = await readSilpoErrorCode(response);
        if (errorCode === 'SILPO_REAUTH_REQUIRED') moveToReauthorization();
        else {
          setScreenError(errorCode === 'BRANCH_REQUIRED' ? 'Спочатку оберіть магазин.' : 'Не вдалося знайти товари. Спробуйте ще раз.');
          if (errorCode === 'BRANCH_REQUIRED') setBranchPickerOpen(true);
        }
        return;
      }
      const data: unknown = await response.json();
      if (!isProductSearchResponse(data)) {
        setScreenError('Не вдалося знайти товари. Спробуйте ще раз.');
        return;
      }
      setProducts(data.products.map((product) => toProductSummary(product)).filter((product): product is ProductSummary => product !== null));
    } catch {
      setScreenError('Не вдалося знайти товари. Спробуйте ще раз.');
    } finally {
      setScreenBusy(false);
    }
  };

  const onBranchResolved = (preferredSilpoBranchId: string | null) => {
    if (preferredSilpoBranchId === null) {
      setBranchPickerOpen(true);
      return;
    }
    loadBranches();
    if (params.slug) void loadProductBySlug(params.slug);
    else if (location.pathname === '/favourites') void loadMyItems();
    else if (params.trackingId) void loadHistoryById(params.trackingId);
    else if (sharedSearchQuery) void runProductSearch(sharedSearchQuery);
  };

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    if (state === 'session-checking') {
      void fetch('/api/auth/session', { credentials: 'same-origin' })
        .then(async (response) => {
          if (!response.ok) {
            if (isCleanRoot && response.status === 401) {
              setState('outside-telegram');
              return;
            }
            throw new Error('Session lookup failed');
          }
          const data: unknown = await response.json();
          if (!isBootstrapResponse(data) || data.status !== 'authenticated') throw new Error('Invalid session response');
          setAuthenticated({ csrfToken: data.csrfToken, silpoStatus: data.silpoStatus, preferredSilpoBranchId: data.preferredSilpoBranchId, telegramConnected: data.telegramConnected !== false });
          setState('authenticated');
          if (data.silpoStatus === 'active') onBranchResolved(data.preferredSilpoBranchId);
        })
        .catch(() => setState('error'));
      return;
    }
    if (state !== 'checking') return;

    const initData = window.Telegram?.WebApp?.initData;
    if (!initData) return;

    void fetch('/api/auth/telegram/bootstrap', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'text/plain' },
      body: initData,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Bootstrap failed');

        const data: unknown = await response.json();
        if (!isBootstrapResponse(data)) {
          setState('error');
          return;
        }

        if (data.status === 'oauth_required') window.location.assign(data.authorizationUrl);
        else {
          setAuthenticated({ csrfToken: data.csrfToken, silpoStatus: data.silpoStatus, preferredSilpoBranchId: data.preferredSilpoBranchId, telegramConnected: data.telegramConnected !== false });
          setState('authenticated');
          if (data.silpoStatus === 'active') onBranchResolved(data.preferredSilpoBranchId);
        }
      })
      .catch(() => setState('error'));
  // This effect is guarded by `bootstrapped.current` and runs at most once;
  // route/loader values below are only read at that first, mount-time call.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCleanRoot, loadBranches, state]);

  const connect = async () => {
    if (busy) return;

    setBusy(true);
    setActionError(false);
    try {
      const response = await fetch('/api/auth/silpo/connect/start', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data: unknown = response.ok ? await response.json() : null;
      if (!response.ok || !isAuthorizationResponse(data)) {
        setActionError(true);
        return;
      }

      window.location.assign(data.authorizationUrl);
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  const reauthorize = async () => {
    if (!authenticated || busy) return;

    setBusy(true);
    setActionError(false);
    try {
      const response = await fetch('/api/auth/silpo/reauthorize', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': authenticated.csrfToken },
      });
      const data: unknown = response.ok ? await response.json() : null;
      if (!response.ok || !isAuthorizationResponse(data)) {
        setActionError(true);
        return;
      }

      window.location.assign(data.authorizationUrl);
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  const connectTelegram = async () => {
    if (!authenticated || busy) return;

    setBusy(true);
    setActionError(false);
    try {
      const response = await fetch('/api/telegram/link/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': authenticated.csrfToken },
      });
      const data: unknown = response.ok ? await response.json() : null;
      if (!response.ok || !isDeepLinkResponse(data)) {
        setActionError(true);
        return;
      }

      window.location.assign(data.deepLink);
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  const identityProbe = async () => {
    if (busy) return;

    setBusy(true);
    setActionError(false);
    try {
      const response = await fetch('/api/auth/silpo/identity-probe/start', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data: unknown = response.ok ? await response.json() : null;
      if (!response.ok || !isAuthorizationResponse(data)) {
        setActionError(true);
        return;
      }

      window.location.assign(data.authorizationUrl);
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    if (!authenticated || busy) return;

    setBusy(true);
    setActionError(false);
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': authenticated.csrfToken },
      });
      const data: unknown = response.ok ? await response.json() : null;
      if (!response.ok || typeof data !== 'object' || data === null || (data as Record<string, unknown>).status !== 'logged_out') {
        setActionError(true);
        return;
      }

      setAuthenticated(null);
      setBranches([]);
      setProducts([]);
      setSelectedProduct(null);
      setTrackingItems([]);
      setNotifications([]);
      setHistoryItems([]);
      setSelectedTrackingItem(null);
      setBranchPickerReturnToSearch(false);
      setBranchPickerOpen(false);
      navigate('/');
      setState('outside-telegram');
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  const saveBranch = async (branch: BranchSummary) => {
    if (!authenticated || screenBusy) return;

    setScreenBusy(true);
    setScreenError(null);
    try {
      const response = await fetch('/api/user/branch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': authenticated.csrfToken },
        body: JSON.stringify({ silpoBranchId: branch.silpoBranchId }),
      });
      const data: unknown = response.ok ? await response.json() : null;
      if (!response.ok || typeof data !== 'object' || data === null || typeof (data as Record<string, unknown>).silpoBranchId !== 'string') {
        setScreenError('Не вдалося зберегти магазин. Спробуйте ще раз.');
        return;
      }
      setBranches((current) => [...current.filter((item) => item.silpoBranchId !== branch.silpoBranchId), branch]);
      setAuthenticated((current) => current ? { ...current, preferredSilpoBranchId: (data as { silpoBranchId: string }).silpoBranchId } : current);
      setBranchPickerReturnToSearch(false);
      setBranchPickerOpen(false);
      navigate('/');
      setQuery('');
      setProducts([]);
      setSelectedProduct(null);
      setBranchQuery('');
      setBranchOptions([]);
      setBranchQueryError(null);
      branchCombobox.closeDropdown();
    } catch {
      setScreenError('Не вдалося зберегти магазин. Спробуйте ще раз.');
    } finally {
      setScreenBusy(false);
    }
  };

  const searchProducts = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runProductSearch(query, true);
  };

  const openProduct = async (slug: string) => {
    if (await loadProductBySlug(slug)) navigate(`/product/${encodeURIComponent(slug)}`);
  };

  const toggleFavourite = async () => {
    if (!authenticated || !selectedProduct || screenBusy) return;
    const product = selectedProduct.product;
    if (!product.externalProductId || !product.slug || !product.name) return;

    if (favouriteSubscriptionId) {
      setPendingRemoval({ id: favouriteSubscriptionId, name: product.name, slug: product.slug, imageUrl: product.image, branchId: authenticated.preferredSilpoBranchId ?? '', currentPrice: null });
      return;
    }

    setScreenBusy(true);
    setScreenError(null);
    try {
      const response = await fetch('/api/tracking', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': authenticated.csrfToken },
        body: JSON.stringify({ externalProductId: product.externalProductId, slug: product.slug, name: product.name, imageUrl: product.image }),
      });
      const data: unknown = response.ok ? await response.json() : null;
      const tracking = toTrackingItem(data);
      if (!response.ok || !tracking) throw new Error('Heart failed');
      setFavouriteSubscriptionId(tracking.id);
    } catch {
      setScreenError('Не вдалося змінити вибране. Спробуйте ще раз.');
    } finally {
      setScreenBusy(false);
    }
  };

  const removeFavourite = (item: TrackingItem) => {
    if (!authenticated || screenBusy) return;
    setPendingRemoval(item);
  };

  const confirmRemoval = async () => {
    const item = pendingRemoval;
    if (!authenticated || !item || screenBusy) return;

    setScreenBusy(true);
    setScreenError(null);
    try {
      const response = await fetch(`/api/tracking/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': authenticated.csrfToken },
      });
      const data: unknown = response.ok ? await response.json() : null;
      if (!response.ok || typeof data !== 'object' || data === null || (data as Record<string, unknown>).status !== 'untracked') {
        throw new Error('Unheart failed');
      }
      setTrackingItems((items) => items.filter((current) => current.id !== item.id));
      if (favouriteSubscriptionId === item.id) setFavouriteSubscriptionId(null);
      setPendingRemoval(null);
    } catch {
      setScreenError('Не вдалося змінити вибране. Спробуйте ще раз.');
    } finally {
      setScreenBusy(false);
    }
  };

  const openMyItems = () => {
    if (!authenticated || screenBusy) return;

    navigate('/favourites');
    void loadMyItems();
  };

  const discoverBenefits = async () => {
    if (!authenticated || screenBusy || benefitDiscoveryStatus === 'running') return;

    setBenefitDiscoveryStatus('running');
    try {
      const response = await fetch('/api/silpo/benefits/personal', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': authenticated.csrfToken },
      });
      const data: unknown = response.ok ? await response.json() : null;
      if (!isPersonalBenefitsReport(data) || data.outcome !== 'available') throw new Error('Personal benefits unavailable');
      setPersonalBenefits(data.benefits);
      setBenefitDiscoveryStatus('complete');
    } catch {
      setPersonalBenefits([]);
      setBenefitDiscoveryStatus('unavailable');
    }
  };

  const openHistory = async (item: TrackingItem) => {
    if (screenBusy) return;

    setSelectedTrackingItem(item);
    setHistoryItems([]);
    navigate(`/history/${encodeURIComponent(item.id)}`);
    setScreenBusy(true);
    setScreenError(null);
    try {
      const response = await fetch(`/api/tracking/${encodeURIComponent(item.id)}/history`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('History request failed');
      const data: unknown = await response.json();
      if (!isItemsResponse(data)) throw new Error('Invalid history response');
      setHistoryItems(data.items.map(toHistoryItem).filter((history): history is HistoryItem => history !== null));
    } catch {
      setScreenError('Не вдалося завантажити історію. Спробуйте ще раз.');
    } finally {
      setScreenBusy(false);
    }
  };

  const markNotificationRead = async (notification: NotificationItem) => {
    if (!authenticated || notification.readAt || screenBusy) return;

    setScreenBusy(true);
    setScreenError(null);
    try {
      const response = await fetch(`/api/notifications/${encodeURIComponent(notification.id)}/read`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': authenticated.csrfToken },
      });
      const data: unknown = response.ok ? await response.json() : null;
      if (!response.ok || typeof data !== 'object' || data === null || (data as Record<string, unknown>).status !== 'read') {
        throw new Error('Read notification failed');
      }
      setNotifications((items) => items.map((item) => item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item));
    } catch {
      setScreenError('Не вдалося позначити подію прочитаною. Спробуйте ще раз.');
    } finally {
      setScreenBusy(false);
    }
  };

  const trackableProduct = Boolean(selectedProduct?.product.externalProductId && selectedProduct.product.name);
  const currentBranch = authenticated?.preferredSilpoBranchId
    ? branches.find((branch) => branch.silpoBranchId === authenticated.preferredSilpoBranchId)
    : null;
  const currentBranchLabel = currentBranch
    ? [currentBranch.city, currentBranch.address].filter(Boolean).join(', ') || 'Магазин'
    : authenticated?.preferredSilpoBranchId ? 'Поточний магазин' : 'Оберіть магазин';
  const branchLabel = (branchId: string): string => {
    const branch = branches.find((candidate) => candidate.silpoBranchId === branchId);
    return branch ? [branch.city, branch.address].filter(Boolean).join(', ') || 'Магазин' : 'Магазин';
  };

  return (
    <main className={classes.main}>
      <Container size="lg" className={classes.container}>
      <Group justify="space-between" align="center" className={classes.header}>
        <button type="button" className={classes.brandLink} onClick={() => { setScreenError(null); navigate('/'); }}> <Title order={1}>Cartwise</Title></button>
        {state === 'authenticated' && authenticated && <Group gap="sm" className={classes.headerActions}>
          <Button type="button" variant="light" onClick={() => {
            if (authenticated.silpoStatus !== 'active') return;
            setBranchPickerReturnToSearch(authenticated.preferredSilpoBranchId !== null);
            setScreenError(null);
            setBranchQuery('');
            setBranchOptions([]);
            setBranchQueryError(null);
            setBranchPickerOpen(true);
            if (branches.length === 0 && authenticated.preferredSilpoBranchId !== null) loadBranches();
          }} disabled={screenBusy || authenticated.silpoStatus !== 'active'} aria-label={`Поточний магазин: ${currentBranchLabel}`} aria-describedby="silpo-connection-status">{currentBranchLabel}</Button>
          <span id="silpo-connection-status" className={classes.visuallyHidden}>{authenticated.silpoStatus === 'active' ? 'Сільпо підключено' : 'Потрібно перепідключити Сільпо'}</span>
          {authenticated.telegramConnected === false && (
            <Button variant="light" onClick={() => void connectTelegram()} disabled={busy} leftSection={<IconBrandTelegram size={18} aria-hidden="true" />}>Підключити Telegram</Button>
          )}
          <Button variant="subtle" color="gray" onClick={() => void logout()} disabled={busy} leftSection={<IconLogout size={18} aria-hidden="true" />}>Вийти</Button>
        </Group>}
      </Group>
      <Modal opened={pendingRemoval !== null} onClose={() => setPendingRemoval(null)} title="Видалити з вибраного?" centered>
        <Stack gap="md">
          <Text>Товар «{pendingRemoval?.name}» більше не відстежуватиметься.</Text>
          <Group justify="flex-end">
            <Button type="button" variant="default" onClick={() => setPendingRemoval(null)} disabled={screenBusy}>Скасувати</Button>
            <Button type="button" color="red" onClick={() => void confirmRemoval()} loading={screenBusy}>Видалити</Button>
          </Group>
        </Stack>
      </Modal>
      {state === 'outside-telegram' && (
        <Stack className={classes.screen} gap="md">
          <Text size="lg">Підключіть Сільпо, щоб зберігати вибране та стежити за цінами.</Text>
          <Button type="button" onClick={() => void connect()} disabled={busy}>Підключити Сільпо</Button>
          {actionError && <p>Не вдалося виконати дію. Спробуйте ще раз.</p>}
        </Stack>
      )}
      {state === 'discovery-complete' && (
        <Stack className={classes.screen} gap="md">
          <Text>MCP-каталог отримано. Наступний крок — перевірка Silpo identity.</Text>
          <Button type="button" onClick={() => void identityProbe()} disabled={busy}>Перевірити Silpo identity</Button>
          {actionError && <p>Не вдалося виконати дію. Спробуйте ще раз.</p>}
        </Stack>
      )}
      {state === 'discovery-failed' && <Text className={classes.screen}>Не вдалося отримати MCP-каталог. Спробуйте ще раз.</Text>}
      {state === 'identity-probe-complete' && <Text className={classes.screen}>Identity evidence отримано. Наступний крок — вибір stable subject field.</Text>}
      {state === 'identity-probe-failed' && <Text className={classes.screen}>Не вдалося перевірити Silpo identity. Спробуйте ще раз.</Text>}
      {state === 'error' && <Text className={classes.screen}>Не вдалося відкрити Cartwise. Спробуйте ще раз.</Text>}
      {state === 'authenticated' && authenticated && (
        <>
          {authenticated.silpoStatus !== 'active' && (
            <Button type="button" onClick={() => void reauthorize()} disabled={busy}>Перепідключити</Button>
          )}
          {actionError && <p>Не вдалося виконати дію. Спробуйте ще раз.</p>}
          {authenticated.silpoStatus === 'active' && screen === 'branch-picker' && (
            <section aria-labelledby="branch-picker-heading" className={`${classes.screen} ${classes.branchPicker}`}>
              {branchPickerReturnToSearch && <Button type="button" variant="subtle" leftSection={<IconArrowLeft size={18} aria-hidden="true" />} onClick={() => { setBranchPickerReturnToSearch(false); setScreenError(null); setBranchPickerOpen(false); navigate('/'); }} disabled={screenBusy}>Повернутися до пошуку</Button>}
              <Title order={2} id="branch-picker-heading">Оберіть магазин</Title>
              <Combobox store={branchCombobox} onOptionSubmit={(value) => {
                const branch = branchOptions.find((item) => item.silpoBranchId === value);
                if (branch) void saveBranch(branch);
              }} withinPortal={false}>
                <Combobox.Target>
                  <TextInput
                    label="Пошук магазинів"
                    value={branchQuery}
                    onChange={(event) => updateBranchQuery(event.currentTarget.value)}
                    onFocus={() => { if (branchQuery.trim().length >= 2) branchCombobox.openDropdown(); }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        if (!branchCombobox.dropdownOpened) {
                          branchCombobox.openDropdown('keyboard');
                          branchCombobox.selectActiveOption();
                        } else {
                          branchCombobox.selectNextOption();
                        }
                      }
                      if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        if (!branchCombobox.dropdownOpened) {
                          branchCombobox.openDropdown('keyboard');
                          branchCombobox.selectActiveOption();
                        } else {
                          branchCombobox.selectPreviousOption();
                        }
                      }
                      if (event.key === 'Enter') {
                        if (branchCombobox.dropdownOpened && branchCombobox.getSelectedOptionIndex() !== -1) {
                          event.preventDefault();
                          branchCombobox.clickSelectedOption();
                        }
                      }
                      if (event.key === 'Escape') branchCombobox.closeDropdown('keyboard');
                    }}
                    aria-describedby="branch-query-status"
                  />
                </Combobox.Target>
                <Combobox.Dropdown>
                  <Combobox.Options>
                    {branchQueryBusy && <Combobox.Empty>Пошук магазинів…</Combobox.Empty>}
                    {!branchQueryBusy && !branchQueryError && branchQuery.trim().length >= 2 && branchOptions.length === 0 && <Combobox.Empty>Магазинів не знайдено.</Combobox.Empty>}
                    {branchOptions.map((branch) => {
                      const label = [branch.city, branch.address].filter(Boolean).join(', ') || 'Магазин';
                      return <Combobox.Option value={branch.silpoBranchId} key={branch.silpoBranchId}>{label}</Combobox.Option>;
                    })}
                  </Combobox.Options>
                </Combobox.Dropdown>
              </Combobox>
              <div id="branch-query-status" aria-live="polite">
                {branchQueryError && <Text c="red.9" role="alert">{branchQueryError}</Text>}
              </div>
              {screenError && <Text c="red.9" role="alert">{screenError}</Text>}
            </section>
          )}
          {authenticated.silpoStatus === 'active' && screen === 'search' && (
            <section aria-labelledby="product-search-heading" className={classes.screen}>
              <Title order={2} id="product-search-heading">Пошук товарів</Title>
              <form onSubmit={(event) => void searchProducts(event)} className={classes.searchForm}>
                <Combobox store={productCombobox} onOptionSubmit={(slug) => {
                  productCombobox.closeDropdown();
                  void openProduct(slug);
                }} withinPortal={false}>
                  <Combobox.Target>
                    <TextInput id="product-query" label="Пошук товарів" value={query} onChange={(event) => {
                      setQuery(event.currentTarget.value);
                      setProductOptions([]);
                      setProductQueryError(null);
                    }} onFocus={() => { if (query.trim().length >= 2) productCombobox.openDropdown(); }} onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        if (!productCombobox.dropdownOpened) {
                          productCombobox.openDropdown('keyboard');
                          productCombobox.selectActiveOption();
                        } else {
                          productCombobox.selectNextOption();
                        }
                      }
                      if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        if (!productCombobox.dropdownOpened) {
                          productCombobox.openDropdown('keyboard');
                          productCombobox.selectActiveOption();
                        } else {
                          productCombobox.selectPreviousOption();
                        }
                      }
                      if (event.key === 'Enter' && productCombobox.dropdownOpened && productCombobox.getSelectedOptionIndex() !== -1) {
                        event.preventDefault();
                        productCombobox.clickSelectedOption();
                      }
                      if (event.key === 'Escape') productCombobox.closeDropdown('keyboard');
                    }} />
                  </Combobox.Target>
                  <Combobox.Dropdown>
                    <Combobox.Options>
                      {productQueryBusy && <Combobox.Empty>Шукаємо товари…</Combobox.Empty>}
                      {!productQueryBusy && productQueryError && <Combobox.Empty>{productQueryError}</Combobox.Empty>}
                      {!productQueryBusy && !productQueryError && query.trim().length >= 2 && productOptions.length === 0 && <Combobox.Empty>Товарів не знайдено.</Combobox.Empty>}
                      {productOptions.map((product) => <Combobox.Option value={product.slug} key={product.slug}>
                        <Group gap="sm" wrap="nowrap"><Image src={product.image ?? undefined} alt="" w={36} h={36} fit="contain" /><div><Text size="sm" fw={700}>{product.name || product.slug}</Text>{product.price !== null && <Text size="xs" c="var(--color-accent)">{product.price} ₴</Text>}</div></Group>
                      </Combobox.Option>)}
                    </Combobox.Options>
                    <Combobox.Footer><Button variant="subtle" size="compact-sm" onClick={() => void runProductSearch(query, true)}>Показати всі результати</Button></Combobox.Footer>
                  </Combobox.Dropdown>
                </Combobox>
                <Button type="submit" leftSection={<IconSearch size={18} aria-hidden="true" />} disabled={screenBusy || !query.trim()}>Шукати</Button>
              </form>
              <Button type="button" variant="outline" onClick={() => void openMyItems()} disabled={screenBusy}>Мої товари</Button>
              {screenError && <Text c="red.9">{screenError}</Text>}
              <Stack component="ul" className={classes.productGrid} gap="md">
                {products.map((product) => {
                  const label = product.name || product.slug;
                  return <Card component="li" key={product.slug} withBorder radius={12} className={classes.productCard}>
                    <Button type="button" variant="subtle" onClick={() => void openProduct(product.slug)} disabled={screenBusy}>{label}</Button>
                    {product.brandTitle && <Text c="var(--color-muted)">{product.brandTitle}</Text>}
                    {product.price !== null && <Text fw={700} c="var(--color-accent)">{product.price}</Text>}
                    {product.image && <Image src={product.image} alt={label} maw={160} />}
                  </Card>;
                })}
              </Stack>
            </section>
          )}
          {authenticated.silpoStatus === 'active' && screen === 'my-items' && (
            <section aria-labelledby="my-items-heading" className={classes.screen}>
              <Button type="button" variant="subtle" leftSection={<IconArrowLeft size={18} aria-hidden="true" />} onClick={() => { setScreenError(null); navigate('/'); }} disabled={screenBusy}>Повернутися до пошуку</Button>
              <Title order={2} id="my-items-heading">Мої товари</Title>
              {screenBusy && <Text>Завантаження…</Text>}
              <Title order={3}>Відстежувані товари</Title>
              <Stack component="ul" gap="sm" className={classes.itemList}>
                {trackingItems.map((item) => <Card component="li" key={item.id} withBorder radius={12} className={classes.itemCard}>
                  <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
                    {item.imageUrl ? <Image src={item.imageUrl} alt={item.name} className={classes.trackedImage} /> : <div className={classes.imageFallback} aria-label={`Зображення товару: ${item.name}`}>CW</div>}
                    <div className={classes.itemInfo}>
                      <Text fw={700}>{item.name}</Text>
                      <Text size="sm" c="dimmed">{branchLabel(item.branchId)}</Text>
                    </div>
                    {item.currentPrice !== null && <div className={classes.trackedPrice}>
                      <Text size="xs" c="dimmed">Ціна Сільпо</Text>
                      <Badge color="orange" variant="light" size="lg" className={classes.priceBadge}>{item.currentPrice} ₴</Badge>
                    </div>}
                  </Group>
                  <div className={classes.itemActions}>
                    <Button type="button" size="sm" leftSection={<IconSearch size={16} aria-hidden="true" />} onClick={() => void openProduct(item.slug)} disabled={screenBusy} aria-label="Переглянути товар">Товар</Button>
                    <Button type="button" variant="default" size="sm" leftSection={<IconHistory size={16} aria-hidden="true" />} onClick={() => void openHistory(item)} disabled={screenBusy} aria-label={`Історія: ${item.name}`}>Історія</Button>
                    <Button type="button" variant="subtle" color="red" size="sm" leftSection={<IconHeartFilled size={16} aria-hidden="true" />} onClick={() => void removeFavourite(item)} disabled={screenBusy} aria-label="Видалити з вибраного">Видалити</Button>
                  </div>
                </Card>)}
              </Stack>
              <Button type="button" variant="outline" className={classes.personalBenefitsButton} onClick={() => void discoverBenefits()} disabled={screenBusy || benefitDiscoveryStatus === 'running'}>Перевірити доступні вигоди</Button>
              {benefitDiscoveryStatus === 'complete' && <section aria-labelledby="personal-benefits-heading"><Title order={3} id="personal-benefits-heading">Ваші персональні вигоди</Title>{personalBenefits.length
                ? <Stack component="ul" gap="sm" className={classes.itemList}>{personalBenefits.map((benefit, index) => <Card component="li" key={`${benefit.description}-${index}`} withBorder radius={12} className={classes.itemCard}><Text fw={700}>{benefit.description}</Text>{benefit.rewardText && <Text>{benefit.rewardText}</Text>}{benefit.limitText && <Text size="sm" c="dimmed">{benefit.limitText}</Text>}{benefit.expiresAt && <Text size="sm" c="dimmed">Діє до: {benefit.expiresAt}</Text>}</Card>)}</Stack>
                : <Text>Зараз немає персональних вигод.</Text>}</section>}
              {benefitDiscoveryStatus === 'unavailable' && <Text>Вигоди зараз недоступні для перевірки.</Text>}
              <Title order={3}>Події цін</Title>
              <Stack component="ul" gap="sm" className={classes.itemList}>
                {notifications.map((notification) => <Card component="li" key={notification.id} withBorder radius={12} className={classes.priceEvent}>
                  <Text fw={700} c="var(--color-primary)">{notificationLabel(notification.type)}</Text>
                  <Text className={classes.eventProduct}>{notification.productName}</Text>
                  <Group gap="xs" className={classes.eventPrices}>{notification.price !== null && <Text fw={800} c="var(--color-accent)">{notification.price} ₴</Text>}{notification.oldPrice !== null && <Text size="sm" td="line-through" c="dimmed">Було: {notification.oldPrice} ₴</Text>}</Group>
                  {notification.readAt
                    ? <Text size="sm" c="dimmed">Прочитано</Text>
                    : <Button type="button" size="sm" onClick={() => void markNotificationRead(notification)} disabled={screenBusy}>Позначити прочитаним</Button>}
                </Card>)}
              </Stack>
              {screenError && <Text c="red.9">{screenError}</Text>}
            </section>
          )}
          {authenticated.silpoStatus === 'active' && screen === 'history' && selectedTrackingItem && (
            <section aria-labelledby="history-heading" className={classes.screen}>
              <Button type="button" variant="subtle" leftSection={<IconArrowLeft size={18} aria-hidden="true" />} onClick={() => { setScreenError(null); navigate('/favourites'); }} disabled={screenBusy}>Назад до моїх товарів</Button>
              <Title order={2} id="history-heading">Історія: {selectedTrackingItem.name}</Title>
              {screenBusy && <Text>Завантаження…</Text>}
              {!screenBusy && historyItems.length === 0 && <Text c="dimmed">Ще не зафіксовано жодної зміни ціни цього товару.</Text>}
              <Stack component="ul" gap="sm" className={classes.itemList}>
                {historyItems.map((item, index) => <Card component="li" withBorder radius={12} className={classes.historyRow} key={`${item.observedAt}-${index}`}>
                  <Text size="sm" c="dimmed">{observedDate(item.observedAt)}</Text>
                  <Group justify="space-between" align="baseline">{item.price !== null && <Text fw={800} c="var(--color-accent)">{item.price} ₴</Text>}{item.oldPrice !== null && <Text size="sm" td="line-through" c="dimmed">Було: {item.oldPrice} ₴</Text>}</Group>
                </Card>)}
              </Stack>
              {screenError && <Text c="red.9">{screenError}</Text>}
            </section>
          )}
          {authenticated.silpoStatus === 'active' && screen === 'detail' && selectedProduct && (
            <section aria-labelledby="product-detail-heading" className={classes.screen}>
              <Button type="button" variant="subtle" leftSection={<IconArrowLeft size={18} aria-hidden="true" />} onClick={() => { setScreenError(null); navigate(-1); }} disabled={screenBusy}>Назад</Button>
              <Title order={2} id="product-detail-heading">{selectedProduct.product.name || selectedProduct.product.slug}</Title>
              {selectedProduct.product.image && <Image src={selectedProduct.product.image} alt={selectedProduct.product.name || selectedProduct.product.slug} maw={320} mx="auto" />}
              {selectedProduct.product.brandTitle && <Text c="var(--color-muted)">{selectedProduct.product.brandTitle}</Text>}
              <Card withBorder radius={12} className={classes.purchaseCard}>
              <div className={classes.priceRow}>
                {selectedProduct.product.price !== null && <Text fw={700} size="xl" c="var(--color-accent)">{selectedProduct.product.price} ₴</Text>}
                {selectedProduct.product.oldPrice !== null && <Text td="line-through" c="var(--color-muted)">{selectedProduct.product.oldPrice} ₴</Text>}
                {selectedProduct.product.available !== null && <Badge color={selectedProduct.product.available ? 'green' : 'gray'}>{selectedProduct.product.available ? 'В наявності' : 'Немає в наявності'}</Badge>}
              </div>
              {selectedProduct.product.stock !== null && <Text size="sm" c="var(--color-muted)">Залишок: {selectedProduct.product.stock} шт.</Text>}
              <Button type="button" className={classes.heartButton} leftSection={favouriteSubscriptionId ? <IconHeartFilled size={20} aria-hidden="true" /> : <IconHeart size={20} aria-hidden="true" />} onClick={() => void toggleFavourite()} disabled={screenBusy || !trackableProduct}>{favouriteSubscriptionId ? 'Видалити з вибраного' : 'Додати до вибраного'}</Button>
              </Card>
              {selectedProduct.analysis && <section aria-label="Оцінка за даними Сільпо" className={classes.detailCard}>
                <Title order={3}>Оцінка за даними Сільпо</Title>
                {selectedProduct.analysis.score !== null && <div className={classes.scoreSummary}><div className={classes.scoreRing} style={{ '--score': selectedProduct.analysis.score } as React.CSSProperties}><span>{selectedProduct.analysis.score}</span><small>/100</small></div><div><Text fw={800}>{selectedProduct.analysis.score}/100</Text><Text size="sm" c="dimmed">{confidenceLabel(selectedProduct.analysis.confidence)}</Text></div><meter className={classes.visuallyHidden} min="0" max="100" value={selectedProduct.analysis.score}>{selectedProduct.analysis.score}</meter></div>}
                <List>{selectedProduct.analysis.factors.map((item) => <List.Item key={item}>{item}</List.Item>)}</List>
                <dl className={classes.attributeGrid}>{selectedProduct.analysis.components.map((item) => <div key={item.key} className={classes.attributeRow}><dt>{item.label}</dt><dd>{item.value ?? 'Немає даних від Сільпо'}</dd></div>)}</dl>
              </section>}
              <dl className={classes.attributeGrid}>{Object.entries(selectedProduct.attributes).map(([key, value]) => <div key={key} className={classes.attributeRow}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
              {screenError && <Text c="red">{screenError}</Text>}
            </section>
          )}
        </>
      )}
      </Container>
    </main>
  );
}
