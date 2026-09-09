import { ButtonHTMLAttributes, InputHTMLAttributes, PropsWithChildren, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export function Card({ children, className = '' }: PropsWithChildren<{ className?: string }>) {
  return <section className={`card ${className}`.trim()}>{children}</section>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: PropsWithChildren<{ tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }>) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function StatCard({ label, value, helper }: { label: string; value: ReactNode; helper?: ReactNode }) {
  return (
    <Card className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {helper ? <div className="stat-helper">{helper}</div> : null}
    </Card>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <div className="loading-state">{label}</div>;
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <Card className="empty-state">
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
    </Card>
  );
}

export function Button({ children, kind = 'primary', ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'secondary' | 'danger' | 'ghost' }>) {
  return <button className={`button button-${kind}`} {...props}>{children}</button>;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className="input" {...props} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="input textarea" {...props} />;
}

export function Table({ children }: PropsWithChildren) {
  return <div className="table-wrap"><table className="data-table">{children}</table></div>;
}

export function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (page: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="pagination">
      <Button kind="secondary" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Previous</Button>
      <span>Page {page} of {totalPages}</span>
      <Button kind="secondary" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>Next</Button>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { label: string; value: string }[]; value: string; onChange: (value: string) => void }) {
  return (
    <div className="tabs">
      {tabs.map((tab) => (
        <button key={tab.value} className={`tab ${value === tab.value ? 'active' : ''}`} onClick={() => onChange(tab.value)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function KeyValueGrid({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <div className="key-value-grid">
      {items.map((item) => (
        <div key={item.label} className="key-value-item">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}
