import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth';
import { Button, Card, Input } from '../components/ui';

export function LoginPage() {
  const navigate = useNavigate();
  const { signIn, loading } = useAuth();
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('Password123!');

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await signIn(email, password);
      navigate('/');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to sign in');
    }
  };

  return (
    <div className="login-shell">
      <Card className="login-card">
        <div className="brand brand-login">
          <div className="brand-mark">S</div>
          <div>
            <strong>Social Admin</strong>
            <span>Moderation, analytics, and platform operations</span>
          </div>
        </div>
        <h1>Administrator sign in</h1>
        <p className="muted">Use an account that has an active admin role in the existing backend.</p>
        <form className="form-grid" onSubmit={onSubmit}>
          <label>
            <span>Email</span>
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="admin@example.com" required />
          </label>
          <label>
            <span>Password</span>
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" required />
          </label>
          <Button type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</Button>
        </form>
      </Card>
    </div>
  );
}
