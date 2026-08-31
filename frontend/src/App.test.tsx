import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

type TelegramWindow = Window & {
  Telegram?: { WebApp?: { initData?: string } };
};

const telegramWindow = window as TelegramWindow;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete telegramWindow.Telegram;
  window.history.replaceState({}, '', '/');
});

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
    json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active' }),
  } as Response);

  render(<App />);

  expect(await screen.findByText('Сільпо підключено')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { credentials: 'same-origin' });
  expect(screen.getByRole('button', { name: 'Вийти' })).toBeInTheDocument();
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
  vi.stubGlobal('location', { assign: assignMock, pathname: '/', search: '', hash: '' });

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
    json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active', silpoExternalId: 'provider-id', accessToken: 'raw-token' })
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
    json: async () => ({ status: 'authenticated', csrfToken: 'session-csrf', silpoStatus: 'active' }),
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
  vi.stubGlobal('location', { assign: assignMock });
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
  vi.stubGlobal('location', { assign: assignMock });

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
    json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'active' }),
  } as Response);

  render(<App />);

  expect(await screen.findByText('Сільпо підключено')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Перепідключити' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Вийти' })).toBeInTheDocument();
});

it('shows reconnect and logout controls when Silpo is missing', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'missing' }),
  } as Response);

  render(<App />);

  expect(await screen.findByText('Потрібно перепідключити Сільпо')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Перепідключити' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Вийти' })).toBeInTheDocument();
});

it('starts reauthorization for reauth_required and sends the CSRF header', async () => {
  telegramWindow.Telegram = { WebApp: { initData: 'query_id=AAH123' } };
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'reauth_required' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ authorizationUrl: 'https://example.test/oauth' }),
    } as Response);
  const assignMock = vi.fn();
  vi.stubGlobal('location', { assign: assignMock });

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
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'reauth_required' }),
    } as Response)
    .mockResolvedValueOnce({ ok: false } as Response);
  const assignMock = vi.fn();
  vi.stubGlobal('location', { assign: assignMock });

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
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'reauth_required' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ authorizationUrl: 42 }),
    } as Response);
  const assignMock = vi.fn();
  vi.stubGlobal('location', { assign: assignMock });

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
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'active' }),
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
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'active' }),
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
      json: async () => ({ status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'active' }),
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
