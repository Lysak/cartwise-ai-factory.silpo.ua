import { createTheme, type MantineColorsTuple } from '@mantine/core';

const primary: MantineColorsTuple = [
  '#EFF6FF',
  '#DBEAFE',
  '#BFDBFE',
  '#93C5FD',
  '#60A5FA',
  '#2563EB',
  '#1D4ED8',
  '#1E40AF',
  '#1E3A8A',
  '#172554',
];

const accent: MantineColorsTuple = [
  '#FFF7ED',
  '#FFEDD5',
  '#FED7AA',
  '#FDBA74',
  '#FB923C',
  '#F97316',
  '#EA580C',
  '#C2410C',
  '#9A3412',
  '#7C2D12',
];

export const cartwiseTheme = createTheme({
  primaryColor: 'primary',
  colors: { primary, accent },
  fontFamily: 'Nunito Sans, sans-serif',
  headings: { fontFamily: 'Rubik, sans-serif' },
  defaultRadius: 'md',
});
