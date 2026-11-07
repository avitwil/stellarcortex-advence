import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

export function CopyField({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="row" style={{ background: 'var(--bg-elev-2)', borderRadius: 'var(--radius-sm)', padding: '6px 6px 6px 12px' }}>
      <span className="mono spacer" dir="ltr">{value}</span>
      <button
        className="btn icon ghost"
        aria-label={`${t('common.copy')}: ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} />
      </button>
    </div>
  );
}
