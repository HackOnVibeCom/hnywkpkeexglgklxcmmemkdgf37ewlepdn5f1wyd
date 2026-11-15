import { useEffect } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { Layout } from './components/Layout';
import { SessionGate } from './components/SessionGate';
import { ButtonLink, EmptyState } from './components/ui';
import { Landing } from './pages/Landing';
import { Discover } from './pages/Discover';
import { CreateTask } from './pages/CreateTask';
import { TestTask } from './pages/TestTask';
import { Dashboard } from './pages/Dashboard';
import { Profile } from './pages/Profile';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function NotFound() {
  return (
    <EmptyState title="Page not found" action={<ButtonLink to="/">Back to home</ButtonLink>}>
      That page does not exist.
    </EmptyState>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ScrollToTop />
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Landing />} />
            <Route path="discover" element={<SessionGate><Discover /></SessionGate>} />
            <Route path="create" element={<SessionGate><CreateTask /></SessionGate>} />
            <Route path="test/:campaignId" element={<SessionGate><TestTask /></SessionGate>} />
            <Route path="dashboard" element={<SessionGate><Dashboard /></SessionGate>} />
            <Route path="profile" element={<SessionGate><Profile /></SessionGate>} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
