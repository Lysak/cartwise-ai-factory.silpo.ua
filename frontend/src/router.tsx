import { createBrowserRouter } from 'react-router';
import App from './App';

// Every route renders the same top-level App component; App derives which
// screen to show from the matched location/params (see the `screen` const
// in App.tsx). Data mode (no loaders/actions) is enough for this SPA.
export function createAppRouter() {
  return createBrowserRouter([
    { path: '/', element: <App /> },
    { path: '/product/:slug', element: <App /> },
    { path: '/favourites', element: <App /> },
    { path: '/history/:trackingId', element: <App /> },
    { path: '*', element: <App /> },
  ]);
}
