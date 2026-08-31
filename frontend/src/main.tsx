import { StrictMode, useMemo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { RouterProvider } from 'react-router';
// @ts-expect-error Vite resolves Mantine's stylesheet at build time.
import '@mantine/core/styles.css';
// @ts-expect-error Vite resolves CSS modules at build time.
import classes from './cartwise-foundation.module.css';
import { cartwiseTheme } from './cartwise-theme';
import { createAppRouter } from './router';

export function AppBootstrap({ children }: { children?: ReactNode } = {}) {
  const router = useMemo(() => createAppRouter(), []);
  return (
    <MantineProvider theme={cartwiseTheme} forceColorScheme="light">
      <div className={classes.root}>
        {children ?? <RouterProvider router={router} />}
      </div>
    </MantineProvider>
  );
}

window.Telegram?.WebApp?.ready?.();
window.Telegram?.WebApp?.expand?.();

const root = document.getElementById('root');

if (root) {
  createRoot(root).render(
    <StrictMode>
      <AppBootstrap />
    </StrictMode>,
  );
}
