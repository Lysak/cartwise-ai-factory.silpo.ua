import { useMantineTheme } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { AppBootstrap } from './main';

beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function ThemeProbe() {
  const theme = useMantineTheme();

  return <output data-testid="theme-probe">{theme.primaryColor}:{theme.colors.primary[5]}</output>;
}

it('exposes the configured Mantine theme through the actual AppBootstrap provider', () => {
  render(
    <AppBootstrap>
      <ThemeProbe />
    </AppBootstrap>,
  );

  expect(screen.getByTestId('theme-probe')).toHaveTextContent('primary:#2563EB');
});
