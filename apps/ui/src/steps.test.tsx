// FR-CODE-04: engine commands and diffs render in the chat.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import './i18n';
import { EngineSteps } from './screens/chat/ChatView';

describe('FR-CODE-04 engine steps in chat', () => {
  it('shows commands with exit codes and colours diff lines', () => {
    const { container, getByText } = render(<EngineSteps steps={[
      { id: '1', kind: 'command', title: 'npm test', body: 'ok 3 passed', status: 'done', exitCode: 0 },
      { id: '2', kind: 'diff', title: 'src/a.ts', body: '--- a\n+++ b\n-old\n+new', status: 'done', exitCode: null },
      { id: '3', kind: 'command', title: 'make', body: '', status: 'running', exitCode: null },
    ]} />);
    expect(getByText('npm test')).toBeTruthy();
    expect(getByText('exit 0')).toBeTruthy();
    expect(getByText('running…')).toBeTruthy();
    expect(container.querySelector('.add')?.textContent).toBe('+new\n');
    expect(container.querySelector('.del')?.textContent).toBe('-old\n');
    expect(container.querySelectorAll('.step').length).toBe(3);
  });
});
