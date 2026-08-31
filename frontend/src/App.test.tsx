import { StrictMode, useMemo } from 'react';
import { MantineProvider } from '@mantine/core';
import { RouterProvider } from 'react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createAppRouter } from './router';
import { cartwiseTheme } from './cartwise-theme';

const App = () => {
  const router = useMemo(() => createAppRouter(), []);
  return <MantineProvider theme={cartwiseTheme} forceColorScheme="light"><RouterProvider router={router} /></MantineProvider>;
};

type TelegramWindow = Window & {
  Telegram?: { WebApp?: { initData?: string } };
};

const telegramWindow = window as TelegramWindow;

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete telegramWindow.Telegram;
  window.history.replaceState({}, '', '/');
});

async function openSearchStorePicker() {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: 'branch-1' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ branches: [
        { silpoBranchId: 'branch-1', city: 'Київ', address: 'Велика 1' },
        { silpoBranchId: 'branch-2', city: 'Львів', address: 'Стрийська 2' },
      ] }),
    } as Response);
  render(<App />);
  await screen.findByRole('heading', { name: 'Пошук товарів' });
  const currentStore = await screen.findByRole('button', { name: 'Поточний магазин: Київ, Велика 1' });
  await waitFor(() => expect(currentStore).not.toBeDisabled());
  fireEvent.click(currentStore);
  await screen.findByRole('heading', { name: 'Оберіть магазин' });
  return fetchMock;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it('shows a browser-neutral Silpo login action outside Telegram after an unauthenticated session lookup', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401 } as Response);

  render(<App />);

  expect(await screen.findByRole('button', { name: 'Підключити Сільпо' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/auth/session', { credentials: 'same-origin' });
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { credentials: 'same-origin' });
});

it('restores an active Silpo session on a clean root visit outside Telegram', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: null }),
  } as Response);

  render(<App />);

  expect(await screen.findByText('Сільпо підключено')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Оберіть магазин' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { credentials: 'same-origin' });
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/silpo/branches?q=')).toBe(false);
  expect(screen.queryByRole('option', { hidden: true })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Вийти' })).toBeInTheDocument();
});

it('restores the saved store and loads its sanitized label on a clean root visit', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: 'branch-1' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ branches: [{ silpoBranchId: 'branch-1', city: 'Київ', address: 'Велика 1' }] }),
    } as Response);

  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Пошук товарів' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Оберіть магазин' })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/silpo/branches?q=', { credentials: 'same-origin' });
});

it('opens a shared product search URL with its query and results', async () => {
  window.history.replaceState({}, '', '/?q=%D1%81%D0%B0%D0%BD+%D1%81%D0%B0%D0%BD%D0%B8%D1%87');
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: 'branch-1' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ branches: [{ silpoBranchId: 'branch-1', city: 'Київ', address: 'Велика 1' }] }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ products: [{ slug: 'san-sanych', name: 'Насіння Соняшника Сан Санич', price: 58.49 }] }),
    } as Response);

  render(<App />);

  expect(await screen.findByRole('textbox', { name: 'Пошук товарів' })).toHaveValue('сан санич');
  expect(await screen.findByText('Насіння Соняшника Сан Санич')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/silpo/products?q=%D1%81%D0%B0%D0%BD+%D1%81%D0%B0%D0%BD%D0%B8%D1%87&limit=20', { credentials: 'same-origin' });
});

it('keeps the saved-label background branch response out of the picker options', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: 'branch-1' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ branches: [{ silpoBranchId: 'branch-1', city: 'Київ', address: 'Велика 1' }] }),
    } as Response);

  render(<App />);

  const currentStore = await screen.findByRole('button', { name: 'Поточний магазин: Київ, Велика 1' });
  fireEvent.click(currentStore);
  expect(await screen.findByRole('heading', { name: 'Оберіть магазин' })).toBeInTheDocument();
  expect(screen.queryAllByRole('option', { hidden: true })).toHaveLength(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/silpo/branches?q=', { credentials: 'same-origin' });
});

it('shows the restored current store and lets the user return from the picker without saving', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: 'branch-1' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ branches: [
        { silpoBranchId: 'branch-1', city: 'Київ', address: 'Велика 1' },
      ] }),
    } as Response);

  render(<App />);

  const currentStore = await screen.findByRole('button', { name: 'Поточний магазин: Київ, Велика 1' });
  expect(currentStore).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/silpo/branches?q=', { credentials: 'same-origin' });

  fireEvent.click(currentStore);
  expect(await screen.findByRole('heading', { name: 'Оберіть магазин' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Повернутися до пошуку' }));

  expect(await screen.findByRole('heading', { name: 'Пошук товарів' })).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/api/user/branch', expect.anything());
});

it('changes the current store with the existing CSRF request and clears the search state', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: 'branch-1' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ branches: [
        { silpoBranchId: 'branch-1', city: 'Київ', address: 'Велика 1' },
      ] }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ products: [{ slug: 'milk', name: 'Молоко' }] }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ product: { slug: 'milk', name: 'Молоко' }, attributes: {} }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ branches: [{ silpoBranchId: 'branch-2', city: 'Львів', address: 'Стрийська 2' }] }),
    } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ silpoBranchId: 'branch-2' }) } as Response);

  render(<App />);

  const queryInput = await screen.findByRole('textbox', { name: 'Пошук товарів' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Поточний магазин: Київ, Велика 1' })).not.toBeDisabled());
  fireEvent.change(queryInput, { target: { value: 'milk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Шукати' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Молоко' }));
  expect(await screen.findByRole('heading', { name: 'Молоко' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Поточний магазин: Київ, Велика 1' }));
  expect(await screen.findByRole('button', { name: 'Повернутися до пошуку' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Повернутися до пошуку' }));
  expect(await screen.findByRole('heading', { name: 'Пошук товарів' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Поточний магазин: Київ, Велика 1' }));
  vi.useFakeTimers();
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ branches: [{ silpoBranchId: 'branch-2', city: 'Львів', address: 'Стрийська 2' }] }) } as Response);
  const branchInput = screen.getByRole('textbox', { name: 'Пошук магазинів' });
  await act(async () => {
    fireEvent.change(branchInput, { target: { value: 'lv' } });
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
  });
  const branchOption = await vi.waitFor(() => screen.getByRole('option', { name: 'Львів, Стрийська 2', hidden: true }));
  await act(async () => {
    fireEvent.click(branchOption);
    await Promise.resolve();
    await Promise.resolve();
  });

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/user/branch', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'session-csrf' },
    body: JSON.stringify({ silpoBranchId: 'branch-2' }),
  }));
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Поточний магазин: Львів, Стрийська 2' })).toBeInTheDocument());
  expect(screen.getByRole('heading', { name: 'Пошук товарів' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Пошук товарів' })).toHaveValue('');
  expect(screen.queryByText('Молоко')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Молоко' })).not.toBeInTheDocument();
});

it('shows a generic error for a non-401 clean root session failure', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);

  render(<App />);

  expect(await screen.findByText('Не вдалося відкрити Cartwise. Спробуйте ще раз.')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { credentials: 'same-origin' });
  expect(screen.queryByRole('button', { name: 'Підключити Сільпо' })).not.toBeInTheDocument();
});

it('starts Silpo login outside Telegram and navigates only to the server returned URL', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ authorizationUrl: 'https://example.test/authorize' })
  } as Response);
  const assignMock = vi.fn();
  vi.stubGlobal('location', { assign: assignMock, origin: 'http://localhost:3000', href: 'http://localhost:3000/', pathname: '/', search: '', hash: '' });

  fetchMock
    .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ authorizationUrl: 'https://example.test/authorize' }),
    } as Response);

  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Підключити Сільпо' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/silpo/connect/start', {
    method: 'POST', credentials: 'same-origin'
  }));
  expect(assignMock).toHaveBeenCalledWith('https://example.test/authorize');
});

it('loads only generic session status after silpo=connected', async () => {
  window.history.pushState({}, '', '/?silpo=connected');
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: null, silpoExternalId: 'provider-id', accessToken: 'raw-token' })
  } as Response);

  render(<App />);

  expect(await screen.findByText('Сільпо підключено')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { credentials: 'same-origin' });
  expect(screen.queryByText('provider-id')).not.toBeInTheDocument();
  expect(screen.queryByText('raw-token')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Вийти' })).toBeInTheDocument();
});

it('keeps silpo=connected as a generic error when the session is unauthorized', async () => {
  window.history.pushState({}, '', '/?silpo=connected');
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401 } as Response);

  render(<App />);

  expect(await screen.findByText('Не вдалося відкрити Cartwise. Спробуйте ще раз.')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { credentials: 'same-origin' });
  expect(screen.queryByRole('button', { name: 'Підключити Сільпо' })).not.toBeInTheDocument();
});

it('keeps silpo=connected as a generic error for an invalid session payload', async () => {
  window.history.pushState({}, '', '/?silpo=connected');
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ status: 'authenticated' }),
  } as Response);

  render(<App />);

  expect(await screen.findByText('Не вдалося відкрити Cartwise. Спробуйте ще раз.')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { credentials: 'same-origin' });
  expect(screen.queryByText('Сільпо підключено')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Вийти' })).not.toBeInTheDocument();
});

it('performs a clean root session lookup once in StrictMode', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: null }),
  } as Response);

  render(<StrictMode><App /></StrictMode>);

  expect(await screen.findByText('Сільпо підключено')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('shows evidence pending after silpo_discovery=complete without claiming authentication', () => {
  window.history.pushState({}, '', '/?silpo_discovery=complete');

  render(<App />);

  expect(screen.getByText('MCP-каталог отримано. Наступний крок — перевірка Silpo identity.')).toBeInTheDocument();
  expect(screen.queryByText('Сільпо підключено')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Вийти' })).not.toBeInTheDocument();
});

it('starts the identity probe from the completed catalog state', async () => {
  window.history.pushState({}, '', '/?silpo_discovery=complete');
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ authorizationUrl: 'https://example.test/identity-authorize' })
  } as Response);
  const assignMock = vi.fn();

  render(<App />);
  vi.stubGlobal('location', { assign: assignMock, origin: 'http://localhost:3000', href: 'http://localhost:3000/', pathname: '/', search: '', hash: '' });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити Silpo identity' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/silpo/identity-probe/start', {
    method: 'POST', credentials: 'same-origin'
  }));
  expect(assignMock).toHaveBeenCalledWith('https://example.test/identity-authorize');
});

it('shows identity evidence pending without claiming authentication', () => {
  window.history.pushState({}, '', '/?silpo_identity_probe=complete');

  render(<App />);

  expect(screen.getByText('Identity evidence отримано. Наступний крок — вибір stable subject field.')).toBeInTheDocument();
  expect(screen.queryByText('Сільпо підключено')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Вийти' })).not.toBeInTheDocument();
});

it('shows generic retry text for a non-OK bootstrap response without rendering initData', async () => {
  const initData = 'query_id=AAH123&hash=never-display';
  telegramWindow.Telegram = { WebApp: { initData } };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as Response);

  render(<App />);

  expect(await screen.findByText('Не вдалося відкрити Cartwise. Спробуйте ще раз.')).toBeInTheDocument();
  expect(screen.queryByText(initData)).not.toBeInTheDocument();
});

it('posts initData as text and follows only the OAuth URL returned by bootstrap', async () => {
  const initData = 'query_id=AAH123&user=%7B%22id%22%3A42%7D';
  telegramWindow.Telegram = { WebApp: { initData } };
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'oauth_required', authorizationUrl: 'https://example.test/oauth' }),
  } as Response);
  const assignMock = vi.fn();
  vi.stubGlobal('location', { assign: assignMock, origin: 'http://localhost:3000', href: 'http://localhost:3000/', pathname: '/', search: '', hash: '' });

  render(<App />);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/telegram/bootstrap', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'text/plain' },
    body: initData,
  }));
  expect(assignMock).toHaveBeenCalledWith('https://example.test/oauth');
});

it('shows connected status without a reconnect control when Silpo is active', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'active', preferredSilpoBranchId: null }),
  } as Response);

  render(<App />);

  expect(await screen.findByText('Сільпо підключено')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Перепідключити' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Вийти' })).toBeInTheDocument();
});

it('restores the saved store after Telegram bootstrap and loads its label', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'active', preferredSilpoBranchId: 'branch-1' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ branches: [{ silpoBranchId: 'branch-1', city: 'Київ', address: 'Велика 1' }] }),
    } as Response);

  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Пошук товарів' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Оберіть магазин' })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/telegram/bootstrap', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'text/plain' },
    body: 'query_id=AAH123',
  });
  expect(fetchMock).toHaveBeenCalledWith('/api/silpo/branches?q=', { credentials: 'same-origin' });
});

it('shows reconnect and logout controls when Silpo is missing', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'missing', preferredSilpoBranchId: null }),
  } as Response);

  render(<App />);

  expect(await screen.findByText('Потрібно перепідключити Сільпо')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Перепідключити' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Вийти' })).toBeInTheDocument();
});

it('does not show the Telegram connect button when already connected', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'missing', preferredSilpoBranchId: null, telegramConnected: true }),
  } as Response);

  render(<App />);

  await screen.findByRole('button', { name: 'Вийти' });
  expect(screen.queryByRole('button', { name: 'Підключити Telegram' })).not.toBeInTheDocument();
});

it('shows the Telegram connect button and starts linking when not connected', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'missing', preferredSilpoBranchId: null, telegramConnected: false }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ deepLink: 'https://t.me/CartwiseBot?start=link_raw-token' }),
    } as Response);
  const assignMock = vi.fn();
  vi.stubGlobal('location', { assign: assignMock, origin: 'http://localhost:3000', href: 'http://localhost:3000/', pathname: '/', search: '', hash: '' });

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Підключити Telegram' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/telegram/link/start', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': 'test-csrf' },
  }));
  expect(assignMock).toHaveBeenCalledWith('https://t.me/CartwiseBot?start=link_raw-token');
});

it('does not navigate and shows a generic error when starting the Telegram link fails', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'missing', preferredSilpoBranchId: null, telegramConnected: false }),
    } as Response)
    .mockResolvedValueOnce({ ok: false } as Response);
  const assignMock = vi.fn();
  vi.stubGlobal('location', { assign: assignMock, origin: 'http://localhost:3000', href: 'http://localhost:3000/', pathname: '/', search: '', hash: '' });

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Підключити Telegram' }));

  expect(await screen.findByText('Не вдалося виконати дію. Спробуйте ще раз.')).toBeInTheDocument();
  expect(assignMock).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('starts reauthorization for reauth_required and sends the CSRF header', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'reauth_required', preferredSilpoBranchId: null }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ authorizationUrl: 'https://example.test/oauth' }),
    } as Response);
  const assignMock = vi.fn();
  vi.stubGlobal('location', { assign: assignMock, origin: 'http://localhost:3000', href: 'http://localhost:3000/', pathname: '/', search: '', hash: '' });

  render(<App />);

  await screen.findByRole('button', { name: 'Перепідключити' });
  fireEvent.click(screen.getByRole('button', { name: 'Перепідключити' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/silpo/reauthorize', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': 'test-csrf' },
  }));
  expect(assignMock).toHaveBeenCalledWith('https://example.test/oauth');
});

it('does not navigate and shows a generic error when reauthorization is not OK', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'reauth_required', preferredSilpoBranchId: null }),
    } as Response)
    .mockResolvedValueOnce({ ok: false } as Response);
  const assignMock = vi.fn();
  vi.stubGlobal('location', { assign: assignMock, origin: 'http://localhost:3000', href: 'http://localhost:3000/', pathname: '/', search: '', hash: '' });

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Перепідключити' }));

  expect(await screen.findByText('Не вдалося виконати дію. Спробуйте ще раз.')).toBeInTheDocument();
  expect(assignMock).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('does not navigate and shows a generic error for a malformed reauthorization response', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'reauth_required', preferredSilpoBranchId: null }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ authorizationUrl: 42 }),
    } as Response);
  const assignMock = vi.fn();
  vi.stubGlobal('location', { assign: assignMock, origin: 'http://localhost:3000', href: 'http://localhost:3000/', pathname: '/', search: '', hash: '' });

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Перепідключити' }));

  expect(await screen.findByText('Не вдалося виконати дію. Спробуйте ще раз.')).toBeInTheDocument();
  expect(assignMock).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('logs out with the CSRF header and returns to the Telegram entry state', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'active', preferredSilpoBranchId: null }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'logged_out' }),
    } as Response);

  render(<App />);

  await screen.findByRole('button', { name: 'Вийти' });
  fireEvent.click(screen.getByRole('button', { name: 'Вийти' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': 'test-csrf' },
  }));
  expect(await screen.findByRole('button', { name: 'Підключити Сільпо' })).toBeInTheDocument();
});

it('does not reset authenticated state and shows a generic error when logout is not OK', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'active', preferredSilpoBranchId: null }),
    } as Response)
    .mockResolvedValueOnce({ ok: false } as Response);

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Вийти' }));

  expect(await screen.findByText('Не вдалося виконати дію. Спробуйте ще раз.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Підключити Сільпо' })).not.toBeInTheDocument();
  expect(screen.getByText('Сільпо підключено')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('does not reset authenticated state and shows a generic error for malformed logout response', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'active', preferredSilpoBranchId: null }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'still_authenticated' }),
    } as Response);

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Вийти' }));

  expect(await screen.findByText('Не вдалося виконати дію. Спробуйте ще раз.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Підключити Сільпо' })).not.toBeInTheDocument();
  expect(screen.getByText('Сільпо підключено')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

const activeSession = {
  ok: true,
  status: 200,
  json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: null }),
} as Response;

const branchesResponse = {
  ok: true,
  status: 200,
  json: async () => ({ branches: [{ silpoBranchId: 'branch-1', city: 'Київ', address: 'Велика 1' }], nextOffset: null }),
} as Response;

async function openBranchPicker() {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(activeSession);
  render(<App />);
  await screen.findByRole('heading', { name: 'Оберіть магазин' });
  fetchMock.mockResolvedValueOnce(branchesResponse);
  vi.useFakeTimers();
  fireEvent.change(screen.getByRole('textbox', { name: 'Пошук магазинів' }), { target: { value: 'Київ' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(450); });
  expect(screen.getByRole('option', { name: 'Київ, Велика 1', hidden: true })).toBeInTheDocument();
  vi.useRealTimers();
  return fetchMock;
}

const validV2Analysis = {
  score: 73,
  confidence: 'high',
  factors: ['+3: енергетична цінність 180 кКал'],
  components: [
    { key: 'energy', label: 'Енергія', value: '180 кКал' },
    { key: 'protein', label: 'Білки', value: '8 г' },
    { key: 'fat', label: 'Жири', value: null },
    { key: 'carbohydrates', label: 'Вуглеводи', value: '12 г' },
    { key: 'ingredients', label: 'Склад / E-добавки', value: 'Склад є, E-добавок не знайдено' },
    { key: 'organic', label: 'Органічність', value: null },
    { key: 'allergens', label: 'Алергени', value: 'Є дані від Сільпо' },
  ],
  unavailableComponents: ['fat', 'organic'],
  algorithmVersion: 'v2',
  sourceHash: 'a'.repeat(64),
};

const validAnalysis = validV2Analysis;

async function openProductDetail(analysis: unknown) {
  const fetchMock = await openBranchPicker();
  fetchMock
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ silpoBranchId: 'branch-1' }) } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ products: [{ slug: 'milk', name: 'Молоко' }] }) } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ product: { slug: 'milk', name: 'Молоко' }, attributes: {}, analysis }),
    } as Response);

  fireEvent.click(screen.getByRole('option', { name: /Київ.*Велика 1/, hidden: true }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Пошук товарів' }), { target: { value: 'milk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Шукати' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Молоко' }));
  await screen.findByRole('heading', { name: 'Молоко' });
  return fetchMock;
}

it('shows the branch picker before product search for an active session', async () => {
  const fetchMock = await openBranchPicker();

  expect(screen.getByRole('option', { name: /Київ.*Велика 1/, hidden: true })).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Пошук товарів' })).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/api/silpo/branches?q=', { credentials: 'same-origin' });
});

it('saves the selected branch with the session CSRF token and opens search', async () => {
  const fetchMock = await openBranchPicker();
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ silpoBranchId: 'branch-1' }) } as Response);

  fireEvent.click(screen.getByRole('option', { name: /Київ.*Велика 1/, hidden: true }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/user/branch', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'session-csrf' },
    body: JSON.stringify({ silpoBranchId: 'branch-1' }),
  }));
  expect(await screen.findByRole('heading', { name: 'Пошук товарів' })).toBeInTheDocument();
});

it('renders only sanitized product fields for a non-empty search query', async () => {
  const fetchMock = await openBranchPicker();
  fetchMock
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ silpoBranchId: 'branch-1' }) } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ products: [{ slug: 'milk', name: 'Молоко', brandTitle: 'Brand', price: 42, accessToken: 'never-display', branchId: 'hidden' }] }),
    } as Response);

  fireEvent.click(screen.getByRole('option', { name: /Київ.*Велика 1/, hidden: true }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Пошук товарів' }), { target: { value: 'milk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Шукати' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/silpo/products?q=milk&limit=20', { credentials: 'same-origin' }));
  expect(await screen.findByText('Молоко')).toBeInTheDocument();
  expect(screen.getByText('Brand')).toBeInTheDocument();
  expect(screen.getByText('42')).toBeInTheDocument();
  expect(screen.queryByText('never-display')).not.toBeInTheDocument();
  expect(screen.queryByText('hidden')).not.toBeInTheDocument();
});

it('shows a debounced product combobox and opens the chosen suggestion', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: 'branch-1' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ branches: [{ silpoBranchId: 'branch-1', city: 'Київ', address: 'Велика 1' }] }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ products: [{ slug: 'san-sanych', name: 'Насіння Сан Санич', price: 58.49, image: 'https://img.test/san.jpg' }] }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ product: { slug: 'san-sanych', name: 'Насіння Сан Санич', price: 58.49 }, attributes: {} }),
    } as Response);

  render(<App />);
  const input = await screen.findByRole('textbox', { name: 'Пошук товарів' });
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: 'сан' } });
  expect(screen.queryByRole('option', { name: 'Насіння Сан Санич', hidden: true })).not.toBeInTheDocument();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByRole('option', { name: /Насіння Сан Санич/, hidden: true })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/silpo/products?q=%D1%81%D0%B0%D0%BD&limit=5', { credentials: 'same-origin' });
  fireEvent.click(screen.getByRole('option', { name: /Насіння Сан Санич/, hidden: true }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByRole('heading', { name: 'Насіння Сан Санич' })).toBeInTheDocument();
});

it('loads product detail from the selected result and supports going back', async () => {
  const fetchMock = await openBranchPicker();
  fetchMock
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ silpoBranchId: 'branch-1' }) } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ products: [{ slug: 'milk', name: 'Молоко' }] }) } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ product: { slug: 'milk', name: 'Молоко', image: 'https://img.test/milk.jpg' }, attributes: { Жирність: '2.5%', accessToken: 'never-display' } }) } as Response);

  fireEvent.click(screen.getByRole('option', { name: /Київ.*Велика 1/, hidden: true }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Пошук товарів' }), { target: { value: 'milk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Шукати' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Молоко' }));

  expect(await screen.findByRole('heading', { name: 'Молоко' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Молоко' })).toHaveAttribute('src', 'https://img.test/milk.jpg');
  expect(screen.getByText('2.5%')).toBeInTheDocument();
  expect(screen.queryByText('never-display')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/silpo/products/milk', { credentials: 'same-origin' });

  fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
  expect(await screen.findByRole('heading', { name: 'Пошук товарів' })).toBeInTheDocument();
});

it('keeps product detail when the optional analysis payload is malformed', async () => {
  const fetchMock = await openBranchPicker();
  fetchMock
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ silpoBranchId: 'branch-1' }) } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ products: [{ slug: 'milk', name: 'Молоко' }] }) } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        product: { slug: 'milk', name: 'Молоко' },
        attributes: { 'Жирність': '2.5%' },
        analysis: { score: 'not-a-number', confidence: 'unknown', factors: 'malformed', components: [] },
      }),
    } as Response);

  fireEvent.click(screen.getByRole('option', { name: /Київ.*Велика 1/, hidden: true }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Пошук товарів' }), { target: { value: 'milk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Шукати' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Молоко' }));

  expect(await screen.findByRole('heading', { name: 'Молоко' })).toBeInTheDocument();
  expect(screen.getByText('2.5%')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Оцінка за даними Сільпо' })).not.toBeInTheDocument();
  expect(screen.queryByText('Не вдалося відкрити товар. Спробуйте ще раз.')).not.toBeInTheDocument();
});

it.each([
  ['duplicate', validAnalysis.components.map((component, index) => index === 5 ? { ...component, key: 'energy' } : component)],
  ['unknown', validAnalysis.components.map((component, index) => index === 5 ? { ...component, key: 'vitamins' } : component)],
])('ignores analysis with %s component keys', async (_description, components) => {
  await openProductDetail({ ...validAnalysis, components });

  expect(screen.queryByRole('region', { name: 'Оцінка за даними Сільпо' })).not.toBeInTheDocument();
});

it('ignores v2 analysis that exposes raw allergen text', async () => {
  const components = validV2Analysis.components.map((component) =>
    component.key === 'allergens' ? { ...component, value: 'Молочний алерген' } : component
  );
  await openProductDetail({ ...validV2Analysis, components });

  expect(screen.queryByRole('region', { name: 'Оцінка за даними Сільпо' })).not.toBeInTheDocument();
  expect(screen.queryByText('Молочний алерген')).not.toBeInTheDocument();
});

it.each([
  ['an additional component field', { ...validAnalysis, components: validAnalysis.components.map((component, index) => index === 0 ? { ...component, raw: 'secret' } : component) }],
  ['an untrusted factor', { ...validAnalysis, factors: ['provider secret'] }],
])('ignores analysis with %s', async (_description, analysis) => {
  await openProductDetail(analysis);

  expect(screen.queryByRole('region', { name: 'Оцінка за даними Сільпо' })).not.toBeInTheDocument();
});

it.each([
  ['a score without confidence', { ...validAnalysis, confidence: null }],
  ['confidence without a score', { ...validAnalysis, score: null }],
  ['a score outside the meter range', { ...validAnalysis, score: 101 }],
  ['an unsupported confidence value', { ...validAnalysis, confidence: 'certain' }],
])('ignores analysis with %s', async (_description, analysis) => {
  await openProductDetail(analysis);

  expect(screen.queryByRole('region', { name: 'Оцінка за даними Сільпо' })).not.toBeInTheDocument();
});

it('renders score meter, confidence, and all seven score components', async () => {
  const fetchMock = await openBranchPicker();
  fetchMock
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ silpoBranchId: 'branch-1' }) } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ products: [{ slug: 'milk', name: 'Молоко' }] }) } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        product: { slug: 'milk', name: 'Молоко' },
        attributes: {},
        analysis: validV2Analysis,
      }),
    } as Response);

  fireEvent.click(screen.getByRole('option', { name: /Київ.*Велика 1/, hidden: true }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Пошук товарів' }), { target: { value: 'milk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Шукати' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Молоко' }));

  expect(await screen.findByRole('region', { name: 'Оцінка за даними Сільпо' })).toBeInTheDocument();
  expect(screen.getByRole('meter')).toHaveAttribute('value', '73');
  expect(screen.getByText('73/100')).toBeInTheDocument();
  expect(screen.getByText('висока впевненість')).toBeInTheDocument();
  expect(screen.getByText('Енергія')).toBeInTheDocument();
  expect(screen.getByText('Білки')).toBeInTheDocument();
  expect(screen.getByText('Жири')).toBeInTheDocument();
  expect(screen.getByText('Вуглеводи')).toBeInTheDocument();
  expect(screen.getByText('Склад / E-добавки')).toBeInTheDocument();
  expect(screen.getByText('Органічність')).toBeInTheDocument();
  expect(screen.getAllByText('Немає даних від Сільпо')).toHaveLength(2);
});

it('keeps the seven score gaps visible without showing a meter when no score exists', async () => {
  const fetchMock = await openBranchPicker();
  fetchMock
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ silpoBranchId: 'branch-1' }) } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ products: [{ slug: 'milk', name: 'Молоко' }] }) } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        product: { slug: 'milk', name: 'Молоко' },
        attributes: {},
        analysis: {
          score: null,
          confidence: null,
          factors: [],
          components: [
            { key: 'energy', label: 'Енергія', value: null },
            { key: 'protein', label: 'Білки', value: null },
            { key: 'fat', label: 'Жири', value: null },
            { key: 'carbohydrates', label: 'Вуглеводи', value: null },
            { key: 'ingredients', label: 'Склад / E-добавки', value: null },
            { key: 'organic', label: 'Органічність', value: null },
            { key: 'allergens', label: 'Алергени', value: null },
          ],
          unavailableComponents: ['energy', 'protein', 'fat', 'carbohydrates', 'ingredients', 'organic', 'allergens'],
          algorithmVersion: 'v2',
          sourceHash: 'b'.repeat(64),
        },
      }),
    } as Response);

  fireEvent.click(screen.getByRole('option', { name: /Київ.*Велика 1/, hidden: true }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Пошук товарів' }), { target: { value: 'milk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Шукати' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Молоко' }));

  expect(await screen.findByRole('region', { name: 'Оцінка за даними Сільпо' })).toBeInTheDocument();
  expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  expect(screen.queryByText(/\/100/)).not.toBeInTheDocument();
  expect(screen.getAllByText('Немає даних від Сільпо')).toHaveLength(7);
});

it('renders the safe v2 analysis component and unavailable gaps', async () => {
  await openProductDetail(validV2Analysis);

  expect(screen.getByRole('region', { name: 'Оцінка за даними Сільпо' })).toBeInTheDocument();
  expect(screen.getByRole('meter')).toHaveAttribute('value', '73');
  expect(screen.getByText('Алергени')).toBeInTheDocument();
  expect(screen.getByText('Є дані від Сільпо')).toBeInTheDocument();
  expect(screen.getAllByText('Немає даних від Сільпо')).toHaveLength(2);
});

it('keeps provider and server details generic when branch selection fails with 409', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ...activeSession,
      json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: 'branch-1' }),
    } as Response)
    .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ message: 'provider secret' }) } as Response);

  render(<App />);

  expect(await screen.findByText('Не вдалося завантажити магазини. Спробуйте ще раз.')).toBeInTheDocument();
  expect(screen.queryByText('provider secret')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/silpo/branches?q=', { credentials: 'same-origin' });
});

it('moves the existing session to reauthorization UI when branch loading requires Silpo reauthorization', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ...activeSession,
      json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: 'branch-1' }),
    } as Response)
    .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ code: 'SILPO_REAUTH_REQUIRED' }) } as Response);

  render(<App />);

  expect(await screen.findByText('Потрібно перепідключити Сільпо')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Перепідключити' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Оберіть магазин' })).not.toBeInTheDocument();
  expect(screen.queryByText('Не вдалося завантажити магазини. Спробуйте ще раз.')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/silpo/branches?q=', { credentials: 'same-origin' });
});

it('moves the existing session to reauthorization UI when product search requires Silpo reauthorization', async () => {
  const fetchMock = await openBranchPicker();
  fetchMock
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ silpoBranchId: 'branch-1' }) } as Response)
    .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ code: 'SILPO_REAUTH_REQUIRED' }) } as Response);

  fireEvent.click(screen.getByRole('option', { name: /Київ.*Велика 1/, hidden: true }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Пошук товарів' }), { target: { value: 'milk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Шукати' }));

  expect(await screen.findByText('Потрібно перепідключити Сільпо')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Оберіть магазин' })).not.toBeInTheDocument();
  expect(screen.queryByText('Спочатку оберіть магазин.')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Поточний магазин: Київ, Велика 1' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/silpo/products?q=milk&limit=20', { credentials: 'same-origin' });
});

it('keeps branch-required product search responses on the branch picker', async () => {
  const fetchMock = await openBranchPicker();
  fetchMock
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ silpoBranchId: 'branch-1' }) } as Response)
    .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ code: 'BRANCH_REQUIRED' }) } as Response);

  fireEvent.click(screen.getByRole('option', { name: /Київ.*Велика 1/, hidden: true }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Пошук товарів' }), { target: { value: 'milk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Шукати' }));

  expect(await screen.findByText('Спочатку оберіть магазин.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Оберіть магазин' })).toBeInTheDocument();
  expect(screen.queryByText('Потрібно перепідключити Сільпо')).not.toBeInTheDocument();
});

it('moves the existing session to reauthorization UI when product detail requires Silpo reauthorization', async () => {
  const fetchMock = await openBranchPicker();
  fetchMock
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ silpoBranchId: 'branch-1' }) } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ products: [{ slug: 'milk', name: 'Молоко' }] }) } as Response)
    .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ code: 'SILPO_REAUTH_REQUIRED' }) } as Response);

  fireEvent.click(screen.getByRole('option', { name: /Київ.*Велика 1/, hidden: true }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Пошук товарів' }), { target: { value: 'milk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Шукати' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Молоко' }));

  expect(await screen.findByText('Потрібно перепідключити Сільпо')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Пошук товарів' })).not.toBeInTheDocument();
  expect(screen.queryByText('Спочатку оберіть магазин.')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/silpo/products/milk', { credentials: 'same-origin' });
});

const savedActiveSession = {
  ok: true,
  status: 200,
  json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', preferredSilpoBranchId: 'branch-1' }),
} as Response;

async function openMyItems() {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(savedActiveSession);

  render(<App />);
  await screen.findByRole('heading', { name: 'Пошук товарів' });
  return fetchMock;
}

const responseForMyItems = () => ({
  ok: true,
  status: 200,
  json: async () => ({ items: [] }),
} as Response);

async function openMyItemsForBenefits() {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ status: 'authenticated', csrfToken: 'csrf-token', silpoStatus: 'active', preferredSilpoBranchId: 'branch-1' }),
  } as Response);

  render(<App />);
  await screen.findByRole('heading', { name: 'Пошук товарів' });
  return fetchMock;
}

it('sends CSRF and renders generic personal benefits', async () => {
  const fetchMock = await openMyItemsForBenefits();
  fetchMock
    .mockResolvedValueOnce(responseForMyItems())
    .mockResolvedValueOnce(responseForMyItems())
    .mockResolvedValueOnce({ ok: true, json: async () => ({ outcome: 'available', benefits: [{ active: true, description: 'Ваша вигода', expiresAt: null, limitText: null, rewardText: '5%' }] }) } as Response);

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Перевірити доступні вигоди' }));

  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/silpo/benefits/personal', {
    method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': 'csrf-token' }
  }));
  expect(await screen.findByText('Ваша вигода')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Ваші персональні вигоди' })).toBeInTheDocument();
});

it('keeps benefits discovery below the tracked-item cards, never on a specific product', async () => {
  const fetchMock = await openMyItemsForBenefits();
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: '42.50' }] }),
    } as Response)
    .mockResolvedValueOnce(responseForMyItems())
    .mockResolvedValueOnce({ ok: true, json: async () => ({ outcome: 'available', benefits: [] }) } as Response);

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));
  await screen.findByText('Молоко');
  expect(screen.queryByRole('button', { name: 'Перевірити вигоди' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Перевірити доступні вигоди' }));

  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/silpo/benefits/personal', {
    method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': 'csrf-token' }
  }));
  expect(screen.getByText('Зараз немає персональних вигод.')).toBeInTheDocument();
});

it('does not render inventory paths or values on unavailable probe', async () => {
  const fetchMock = await openMyItemsForBenefits();
  fetchMock
    .mockResolvedValueOnce(responseForMyItems())
    .mockResolvedValueOnce(responseForMyItems())
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ outcome: 'unavailable', benefits: [] }),
    } as Response);

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Перевірити доступні вигоди' }));

  expect(await screen.findByText('Вигоди зараз недоступні для перевірки.')).toBeInTheDocument();
  expect(screen.queryByText('secretCode')).not.toBeInTheDocument();
});

it('renders an own notification and opens its text-list history', async () => {
  const fetchMock = await openMyItems();
  fetchMock.mockReset();
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: '42.50' }] }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'event-1', type: 'price_drop', product: { name: 'Молоко', slug: 'milk', externalProductId: 'product-1' }, price: '42.50', oldPrice: '50.00', createdAt: '2026-09-10T10:00:00.000Z', readAt: null }] }),
    } as Response);

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));

  expect((await screen.findAllByText('Молоко')).length).toBe(2);
  expect(screen.getByText('Ціна Сільпо')).toBeInTheDocument();
  expect(screen.getByText('Зниження ціни')).toBeInTheDocument();
  expect(screen.getAllByText(/42\.50/)).toHaveLength(2);
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ items: [{ price: '50.00', oldPrice: null, observedAt: '2026-09-09T10:00:00.000Z' }, { price: '42.50', oldPrice: '50.00', observedAt: '2026-09-10T10:00:00.000Z' }] }),
  } as Response);
  expect(screen.getByText(/50\.00/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Історія: Молоко' }));

  expect(await screen.findByRole('heading', { name: 'Історія: Молоко' })).toBeInTheDocument();
  expect(screen.getAllByText(/50\.00/)).toHaveLength(2);
  expect(screen.getByText(/42\.50/)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/tracking/subscription-1/history', { credentials: 'same-origin' });
});

it('marks an own notification read with CSRF and disables duplicate actions while pending', async () => {
  const fetchMock = await openMyItems();
  fetchMock.mockReset();
  let resolveRead!: (response: Response) => void;
  const pendingRead = new Promise<Response>((resolve) => { resolveRead = resolve; });
  fetchMock
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [] }) } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'event-1', type: 'price_drop', product: { name: 'Молоко', slug: 'milk', externalProductId: 'product-1' }, price: '42.50', oldPrice: '50.00', createdAt: '2026-09-10T10:00:00.000Z', readAt: null }] }),
    } as Response)
    .mockImplementationOnce(() => pendingRead);

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));
  const readButton = await screen.findByRole('button', { name: 'Позначити прочитаним' });
  fireEvent.click(readButton);
  expect(readButton).toBeDisabled();
  fireEvent.click(readButton);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock).toHaveBeenCalledWith('/api/notifications/event-1/read', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': 'session-csrf' },
  });

  await act(async () => {
    resolveRead({ ok: true, status: 200, json: async () => ({ status: 'read' }) } as Response);
    await Promise.resolve();
  });
  expect(await screen.findByText('Прочитано')).toBeInTheDocument();
});

it('does not render malformed records or provider payload extras', async () => {
  const fetchMock = await openMyItems();
  fetchMock.mockReset();
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: '42.50', providerRaw: 'provider-secret' }, { id: 'bad' }] }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'event-1', type: 'price_drop', product: { name: 'Молоко', slug: 'milk', externalProductId: 'product-1' }, price: '42.50', oldPrice: '50.00', createdAt: '2026-09-10T10:00:00.000Z', readAt: null, payload: { secret: 'provider-secret' } }, { id: 'bad' }] }),
    } as Response);

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));

  expect((await screen.findAllByText('Молоко')).length).toBe(2);
  expect(screen.queryByText('provider-secret')).not.toBeInTheDocument();
  expect(screen.getAllByText('Молоко')).toHaveLength(2);
  expect(screen.queryByText('bad')).not.toBeInTheDocument();
});

it('renders the store label for each tracked item', async () => {
  const fetchMock = await openMyItems();
  fetchMock.mockReset();
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: '42.50' }] }),
    } as Response)
    .mockResolvedValueOnce(responseForMyItems());

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));

  await screen.findByText('Молоко');
  expect(screen.getByText('Магазин')).toBeInTheDocument();
});

it('renders a persisted product thumbnail in a tracked-item card', async () => {
  const fetchMock = await openMyItems();
  fetchMock.mockReset();
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', imageUrl: 'https://img.test/milk.jpg', branchId: 'branch-1', status: 'active', currentPrice: '42.50' }] }),
    } as Response)
    .mockResolvedValueOnce(responseForMyItems());

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));

  expect(await screen.findByRole('img', { name: 'Молоко' })).toHaveAttribute('src', 'https://img.test/milk.jpg');
});

it('opens the product detail screen for a tracked item from My Items', async () => {
  const fetchMock = await openMyItems();
  fetchMock.mockReset();
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: '42.50' }] }),
    } as Response)
    .mockResolvedValueOnce(responseForMyItems())
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ product: { slug: 'milk', name: 'Молоко' }, attributes: {}, analysis: null }),
    } as Response);

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));
  await screen.findByText('Молоко');

  fireEvent.click(screen.getByRole('button', { name: 'Переглянути товар' }));

  expect(await screen.findByRole('heading', { name: 'Молоко' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/product/milk');

  fireEvent.click(screen.getByRole('button', { name: 'Назад' }));

  expect(await screen.findByRole('heading', { name: 'Мої товари' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/favourites');
});

it('keeps the My Items screen and shows a generic error when its API fails', async () => {
  const fetchMock = await openMyItems();
  fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response);

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));

  expect(await screen.findByRole('heading', { name: 'Мої товари' })).toBeInTheDocument();
  expect(await screen.findByText('Не вдалося завантажити мої товари. Спробуйте ще раз.')).toBeInTheDocument();
  expect(screen.queryByText('provider-secret')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/tracking', { credentials: 'same-origin' });
});

it('clears a My Items error when returning to search', async () => {
  const fetchMock = await openMyItems();
  fetchMock.mockReset();
  fetchMock
    .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [] }) } as Response);

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));
  expect(await screen.findByText('Не вдалося завантажити мої товари. Спробуйте ще раз.')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Повернутися до пошуку' }));

  expect(screen.getByRole('heading', { name: 'Пошук товарів' })).toBeInTheDocument();
  expect(screen.queryByText('Не вдалося завантажити мої товари. Спробуйте ще раз.')).not.toBeInTheDocument();
});

async function openTrackableProduct(externalProductId: string | null = 'product-1') {
  const fetchMock = await openBranchPicker();
  fetchMock
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ silpoBranchId: 'branch-1' }) } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ products: [{ slug: 'milk', name: 'Молоко', externalProductId }] }) } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ product: { slug: 'milk', name: 'Молоко', externalProductId }, attributes: {} }),
    } as Response);

  fireEvent.click(screen.getByRole('option', { name: /Київ.*Велика 1/, hidden: true }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Пошук товарів' }), { target: { value: 'milk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Шукати' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Молоко' }));
  await screen.findByRole('heading', { name: 'Молоко' });
  return fetchMock;
}

it('hearts a valid product with exact identity and CSRF, then exposes unheart', async () => {
  const fetchMock = await openTrackableProduct();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: null }),
  } as Response);

  fireEvent.click(screen.getByRole('button', { name: 'Додати до вибраного' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tracking', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'session-csrf' },
    body: JSON.stringify({ externalProductId: 'product-1', slug: 'milk', name: 'Молоко', imageUrl: null }),
  }));
  expect(await screen.findByRole('button', { name: 'Видалити з вибраного' })).toBeInTheDocument();
});

it('unhearts the returned subscription with CSRF and same-origin credentials', async () => {
  const fetchMock = await openTrackableProduct();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: null }),
  } as Response);
  fireEvent.click(screen.getByRole('button', { name: 'Додати до вибраного' }));
  await screen.findByRole('button', { name: 'Видалити з вибраного' });
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'untracked' }) } as Response);

  fireEvent.click(screen.getByRole('button', { name: 'Видалити з вибраного' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Видалити' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tracking/subscription-1', {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': 'session-csrf' },
  }));
  expect(await screen.findByRole('button', { name: 'Додати до вибраного' })).toBeInTheDocument();
});

it('opens a confirmation before deleting a favourite from product detail', async () => {
  const fetchMock = await openTrackableProduct();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: null }),
  } as Response);
  fireEvent.click(screen.getByRole('button', { name: 'Додати до вибраного' }));
  await screen.findByRole('button', { name: 'Видалити з вибраного' });

  fireEvent.click(screen.getByRole('button', { name: 'Видалити з вибраного' }));

  expect(await screen.findByRole('dialog', { name: 'Видалити з вибраного?' })).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url, options]) => url === '/api/tracking/subscription-1' && (options as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
});

it('does not post an invalid product identity and keeps heart unavailable', async () => {
  const fetchMock = await openTrackableProduct(null);

  const heartButton = screen.getByRole('button', { name: 'Додати до вибраного' });
  expect(heartButton).toBeDisabled();
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/tracking')).toBe(false);
});

it('disables repeated heart actions while pending and shows a generic error on failure', async () => {
  const fetchMock = await openTrackableProduct();
  let resolveHeart!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveHeart = resolve; }));

  const heartButton = screen.getByRole('button', { name: 'Додати до вибраного' });
  fireEvent.click(heartButton);
  expect(heartButton).toBeDisabled();
  fireEvent.click(heartButton);
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/tracking')).toHaveLength(1);

  await act(async () => {
    resolveHeart({ ok: false, status: 500 } as Response);
    await Promise.resolve();
  });
  expect(await screen.findByText('Не вдалося змінити вибране. Спробуйте ще раз.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Додати до вибраного' })).toBeEnabled();
});

it('clears a detail-screen error when navigating back to search', async () => {
  const fetchMock = await openTrackableProduct();
  fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
  fireEvent.click(screen.getByRole('button', { name: 'Додати до вибраного' }));
  await screen.findByText('Не вдалося змінити вибране. Спробуйте ще раз.');

  fireEvent.click(screen.getByRole('button', { name: 'Назад' }));

  await screen.findByRole('heading', { name: 'Пошук товарів' });
  expect(screen.queryByText('Не вдалося змінити вибране. Спробуйте ще раз.')).not.toBeInTheDocument();
});

it('removes a persisted favourite from My Items directly without posting a new favourite', async () => {
  const fetchMock = await openMyItems();
  fetchMock.mockReset();
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: '42.50' }] }),
    } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [] }) } as Response);

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));
  const removeButton = await screen.findByRole('button', { name: 'Видалити з вибраного' });
  let resolveRemove!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRemove = resolve; }));

  fireEvent.click(removeButton);
  const confirmButton = await screen.findByRole('button', { name: 'Видалити' });
  fireEvent.click(confirmButton);
  expect(confirmButton).toBeDisabled();
  expect(fetchMock.mock.calls.some(([url, options]) => url === '/api/tracking' && (options as RequestInit | undefined)?.method === 'POST')).toBe(false);
  expect(fetchMock).toHaveBeenCalledWith('/api/tracking/subscription-1', {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': 'session-csrf' },
  });

  await act(async () => {
    resolveRemove({ ok: true, status: 200, json: async () => ({ status: 'untracked' }) } as Response);
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Видалити з вибраного' })).not.toBeInTheDocument());
});

it('keeps the branch picker empty until a normalized query has two characters', async () => {
  const fetchMock = await openSearchStorePicker();
  const input = screen.getByRole('textbox', { name: 'Пошук магазинів' });
  fireEvent.change(input, { target: { value: ' к ' } });
  expect(screen.queryAllByRole('option', { hidden: true })).toHaveLength(0);
  expect(screen.queryByText('Пошук магазинів…')).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/api/silpo/branches?q=k', expect.anything());
});

it('shows the branch query as pending before its debounced response resolves', async () => {
  const fetchMock = await openSearchStorePicker();
  vi.useFakeTimers();
  const pending = deferred<Response>();
  fetchMock.mockImplementationOnce(() => pending.promise);
  await act(async () => {
    fireEvent.change(screen.getByRole('textbox', { name: 'Пошук магазинів' }), { target: { value: 'lv' } });
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(screen.getByText('Пошук магазинів…')).toBeInTheDocument();
  await act(async () => {
    pending.resolve({ ok: true, status: 200, json: async () => ({ branches: [] }) } as Response);
    await Promise.resolve();
  });
});

it('requests one query only after the 400ms debounce', async () => {
  const fetchMock = await openSearchStorePicker();
  vi.useFakeTimers();
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ branches: [{ silpoBranchId: 'branch-2', city: 'Львів', address: 'Стрийська 2' }] }) } as Response);
  const input = screen.getByRole('textbox', { name: 'Пошук магазинів' });
  await act(async () => {
    fireEvent.change(input, { target: { value: ' ки ' } });
    await vi.advanceTimersByTimeAsync(399);
  });
  expect(fetchMock).not.toHaveBeenCalledWith('/api/silpo/branches?q=ки', expect.anything());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(fetchMock).toHaveBeenCalledWith('/api/silpo/branches?q=%D0%BA%D0%B8', { credentials: 'same-origin' });
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/silpo/branches?q=%D0%BA%D0%B8')).toHaveLength(1);
});

it('does not let a stale branch response replace the latest query', async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const fetchMock = await openSearchStorePicker();
  vi.useFakeTimers();
  fetchMock.mockImplementation((input) => {
    if (input === '/api/silpo/branches?q=ky') return first.promise;
    if (input === '/api/silpo/branches?q=lv') return second.promise;
    return Promise.reject(new Error(`Unexpected request: ${input}`));
  });
  const input = screen.getByRole('textbox', { name: 'Пошук магазинів' });
  await act(async () => {
    fireEvent.change(input, { target: { value: 'ky' } });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
  });
  await act(async () => {
    fireEvent.change(input, { target: { value: 'lv' } });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
  });
  await act(async () => {
    second.resolve({ ok: true, status: 200, json: async () => ({ branches: [{ silpoBranchId: 'branch-2', city: 'Львів', address: 'Стрийська 2' }] }) } as Response);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(screen.getByRole('option', { name: 'Львів, Стрийська 2', hidden: true })).toBeInTheDocument());
  await act(async () => {
    first.resolve({ ok: true, status: 200, json: async () => ({ branches: [{ silpoBranchId: 'branch-3', city: 'Одеса', address: 'Дерибасівська 3' }] }) } as Response);
    await Promise.resolve();
  });
  expect(screen.queryByRole('option', { name: 'Одеса, Дерибасівська 3', hidden: true })).not.toBeInTheDocument();
  await vi.waitFor(() => expect(screen.getByRole('option', { name: 'Львів, Стрийська 2', hidden: true })).toBeInTheDocument());
});

it.each([
  ['empty', { ok: true, status: 200, json: async () => ({ branches: [] }) } as Response, 'Магазинів не знайдено.'],
  ['generic error', { ok: false, status: 500 } as Response, 'Не вдалося знайти магазини. Спробуйте ще раз.'],
  ['reauthorization', { ok: false, status: 409, json: async () => ({ code: 'SILPO_REAUTH_REQUIRED' }) } as Response, 'Потрібно перепідключити Сільпо'],
])('shows the %s branch query state', async (_name, response, message) => {
  const fetchMock = await openSearchStorePicker();
  vi.useFakeTimers();
  fetchMock.mockResolvedValueOnce(response);
  await act(async () => {
    fireEvent.change(screen.getByRole('textbox', { name: 'Пошук магазинів' }), { target: { value: 'ки' } });
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByText(message)).toBeInTheDocument();
});

it('selects a branch with keyboard, sends the exact CSRF write, and resets product state', async () => {
  const fetchMock = await openSearchStorePicker();
  vi.useFakeTimers();
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ branches: [{ silpoBranchId: 'branch-2', city: 'Львів', address: 'Стрийська 2' }] }) } as Response);
  const input = screen.getByRole('textbox', { name: 'Пошук магазинів' });
  await act(async () => {
    fireEvent.change(input, { target: { value: 'lv' } });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(screen.getByRole('option', { name: 'Львів, Стрийська 2', hidden: true })).toBeInTheDocument());
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ silpoBranchId: 'branch-2' }) } as Response);
  await act(async () => {
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.advanceTimersByTimeAsync(0);
  });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/user/branch', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': 'session-csrf' }, body: JSON.stringify({ silpoBranchId: 'branch-2' }),
  }));
  await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Пошук товарів' })).toBeInTheDocument());
  expect(screen.getByRole('textbox', { name: 'Пошук товарів' })).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Поточний магазин: Львів, Стрийська 2' })).toBeInTheDocument();
});

it('keeps the current store visible when saving a replacement branch fails', async () => {
  const fetchMock = await openSearchStorePicker();
  vi.useFakeTimers();
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ branches: [{ silpoBranchId: 'branch-2', city: 'Львів', address: 'Стрийська 2' }] }) } as Response);
  const input = screen.getByRole('textbox', { name: 'Пошук магазинів' });
  await act(async () => {
    fireEvent.change(input, { target: { value: 'lv' } });
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
  });
  fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
  const branchOption = await vi.waitFor(() => screen.getByRole('option', { name: 'Львів, Стрийська 2', hidden: true }));
  await act(async () => {
    fireEvent.click(branchOption);
    await Promise.resolve();
    await Promise.resolve();
  });

  await vi.waitFor(() => expect(screen.getByText('Не вдалося зберегти магазин. Спробуйте ще раз.')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Поточний магазин: Київ, Велика 1' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Оберіть магазин' })).toBeInTheDocument();
});

it('returns from the branch picker without writing', async () => {
  const fetchMock = await openSearchStorePicker();
  fireEvent.click(screen.getByRole('button', { name: 'Повернутися до пошуку' }));
  expect(await screen.findByRole('heading', { name: 'Пошук товарів' })).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/user/branch')).toBe(false);
});

it('gives search a distinct bookmarkable URL', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(savedActiveSession);

  render(<App />);

  await screen.findByRole('heading', { name: 'Пошук товарів' });
  expect(window.location.pathname).toBe('/');
});

it('gives product detail a distinct bookmarkable URL after opening it', async () => {
  await openTrackableProduct();

  expect(window.location.pathname).toBe('/product/milk');
});

it('gives favourites a distinct bookmarkable URL after opening it', async () => {
  const fetchMock = await openMyItems();
  fetchMock.mockResolvedValue(responseForMyItems());

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));
  await screen.findByRole('heading', { name: 'Мої товари' });

  expect(window.location.pathname).toBe('/favourites');
});

it('gives tracking history a distinct bookmarkable URL after opening it', async () => {
  const fetchMock = await openMyItems();
  fetchMock.mockReset();
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: '42.50' }] }),
    } as Response)
    .mockResolvedValueOnce(responseForMyItems())
    .mockResolvedValueOnce(responseForMyItems());

  fireEvent.click(screen.getByRole('button', { name: 'Мої товари' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Історія: Молоко' }));
  await screen.findByRole('heading', { name: 'Історія: Молоко' });

  expect(window.location.pathname).toBe('/history/subscription-1');
});

it('supports back/forward navigation between search and product detail', async () => {
  await openTrackableProduct();
  expect(window.location.pathname).toBe('/product/milk');

  await act(async () => {
    window.history.back();
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Пошук товарів' })).toBeInTheDocument());
  expect(window.location.pathname).toBe('/');

  await act(async () => {
    window.history.forward();
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Молоко' })).toBeInTheDocument());
  expect(window.location.pathname).toBe('/product/milk');
});

it('restores the product detail screen from a direct visit to its URL', async () => {
  window.history.pushState({}, '', '/product/milk');
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(savedActiveSession)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ branches: [] }) } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ product: { slug: 'milk', name: 'Молоко' }, attributes: {}, trackingId: 'subscription-1' }) } as Response);

  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Молоко' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Видалити з вибраного' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/silpo/products/milk', { credentials: 'same-origin' });
});

it('restores the favourites screen from a direct visit to its URL, with actual tracked items loaded', async () => {
  window.history.pushState({}, '', '/favourites');
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(savedActiveSession)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ branches: [] }) } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: '42.50' }] }),
    } as Response)
    .mockResolvedValueOnce(responseForMyItems());

  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Мої товари' })).toBeInTheDocument();
  expect(await screen.findByText('Молоко')).toBeInTheDocument();
});

it('restores the history screen from a direct visit to its URL', async () => {
  window.history.pushState({}, '', '/history/subscription-1');
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(savedActiveSession)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ branches: [] }) } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: '42.50' }] }),
    } as Response)
    .mockResolvedValueOnce(responseForMyItems());

  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Історія: Молоко' })).toBeInTheDocument();
  expect(await screen.findByText('Ще не зафіксовано жодної зміни ціни цього товару.')).toBeInTheDocument();
});

it('shows the tracked item after returning from a direct history-link visit, not a false-empty list', async () => {
  window.history.pushState({}, '', '/history/subscription-1');
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(savedActiveSession)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ branches: [] }) } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1', slug: 'milk', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: '42.50' }] }),
    } as Response)
    .mockResolvedValueOnce(responseForMyItems());

  render(<App />);
  await screen.findByRole('heading', { name: 'Історія: Молоко' });

  fireEvent.click(screen.getByRole('button', { name: 'Назад до моїх товарів' }));

  expect(await screen.findByRole('heading', { name: 'Мої товари' })).toBeInTheDocument();
  expect(screen.getByText('Молоко')).toBeInTheDocument();
});
