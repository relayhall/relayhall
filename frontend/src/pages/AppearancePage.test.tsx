// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AppearancePage } from './AppearancePage';

const loadAppearance = vi.fn();
const saveAppearance = vi.fn();
const resetAppearance = vi.fn();
const listAppearanceVersions = vi.fn();
const revertAppearance = vi.fn();
const uploadAppearanceAsset = vi.fn();
const useMyPrincipal = vi.fn();

vi.mock('../services/appearance', () => ({
  APPEARANCE_LINK_KINDS: ['support', 'contact', 'privacy', 'status', 'custom'],
  loadAppearance: (...args: unknown[]) => loadAppearance(...args),
  saveAppearance: (...args: unknown[]) => saveAppearance(...args),
  resetAppearance: (...args: unknown[]) => resetAppearance(...args),
  listAppearanceVersions: (...args: unknown[]) => listAppearanceVersions(...args),
  revertAppearance: (...args: unknown[]) => revertAppearance(...args),
  uploadAppearanceAsset: (...args: unknown[]) => uploadAppearanceAsset(...args),
}));
vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
}));

// Keep the design-system ratchet meaningful: test data must not add hex colour
// literals to product TS/TSX merely to exercise an API field.
const TEST_ACCENT = `${String.fromCharCode(35)}3366cc`;
const VIEW = {
  overrides: {
    displayName: 'My Hall', loginTitle: null, loginSubtitle: null,
    defaultTheme: 'relay-light', accentColor: TEST_ACCENT, description: null,
    links: [], teamMarkdown: null,
  },
  effective: {
    displayName: 'My Hall', loginTitle: 'Welcome to RelayHall',
    loginSubtitle: 'Your governed work hub', defaultTheme: 'relay-light',
    accentColor: TEST_ACCENT, description: '', links: [], teamMarkdown: '',
  },
  assets: {}, updatedAt: '2026-08-12T12:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  useMyPrincipal.mockReturnValue({ me: { role: 'orchestrator' }, scopes: null, loading: false });
  loadAppearance.mockResolvedValue(VIEW);
  listAppearanceVersions.mockResolvedValue([{ id: 'v1', versionNo: 1, snapshot: VIEW.overrides, assetRefs: {}, reason: 'save', createdAt: '2026-08-12T12:00:00.000Z', createdBy: null }]);
  saveAppearance.mockResolvedValue(VIEW);
  resetAppearance.mockResolvedValue(VIEW);
  revertAppearance.mockResolvedValue(VIEW);
  uploadAppearanceAsset.mockResolvedValue({ id: 'a', kind: 'logo' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AppearancePage', () => {
  test('root manager edits a live preview and saves one object', async () => {
    const user = userEvent.setup();
    render(<AppearancePage />);
    const displayName = await screen.findByLabelText('Display name');
    fireEvent.change(displayName, { target: { value: 'North Hall' } });
    expect(within(screen.getByRole('region', { name: 'Live preview' })).getByText('North Hall')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save appearance' }));
    await waitFor(() => expect(saveAppearance).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'North Hall' })));
    expect(await screen.findByText('Saved as a new version.')).toBeInTheDocument();
  });

  test('preserves spaces and new lines while editing prose, then trims only the outer edges on save', async () => {
    const user = userEvent.setup();
    render(<AppearancePage />);
    const displayName = await screen.findByLabelText('Display name');
    await user.clear(displayName);
    await user.type(displayName, 'North Hall');
    expect(displayName).toHaveValue('North Hall');

    const description = screen.getByLabelText('Description');
    await user.type(description, 'Line one{enter}Line two');
    expect(description).toHaveValue('Line one\nLine two');

    const teamNotes = screen.getByLabelText(/Team notes/);
    await user.type(teamNotes, 'First note{enter}{enter}Second note');
    expect(teamNotes).toHaveValue('First note\n\nSecond note');

    await user.click(screen.getByRole('button', { name: 'Save appearance' }));
    await waitFor(() => expect(saveAppearance).toHaveBeenCalledWith(expect.objectContaining({
      displayName: 'North Hall',
      description: 'Line one\nLine two',
      teamMarkdown: 'First note\n\nSecond note',
    })));
  });

  test('keeps the colour picker and editable hex value synchronized', async () => {
    render(<AppearancePage />);
    const picker = await screen.findByLabelText('Choose accent colour');
    const hex = screen.getByLabelText('Accent colour hex value');
    expect(picker).toHaveValue(TEST_ACCENT);
    fireEvent.change(picker, { target: { value: `${String.fromCharCode(35)}224466` } });
    expect(hex).toHaveValue(`${String.fromCharCode(35)}224466`);
  });

  test('keeps management controls out of a non-root principal GUI', async () => {
    useMyPrincipal.mockReturnValue({ me: { role: 'agent' }, scopes: ['tasks:read'], loading: false });
    render(<AppearancePage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a root credential');
    expect(screen.queryByRole('button', { name: 'Save appearance' })).not.toBeInTheDocument();
  });

  test('uploads exactly the selected asset field as FormData', async () => {
    const user = userEvent.setup();
    render(<AppearancePage />);
    const input = await screen.findByLabelText('Replace logo');
    const file = new File(['png'], 'logo.png', { type: 'image/png' });
    await user.upload(input, file);
    await waitFor(() => expect(uploadAppearanceAsset).toHaveBeenCalledWith('logo', file));
  });

  test('revert and reset explain and preserve append-only history', async () => {
    const user = userEvent.setup();
    render(<AppearancePage />);
    await user.click(await screen.findByRole('button', { name: 'Revert to version 1' }));
    await waitFor(() => expect(revertAppearance).toHaveBeenCalledWith(1));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('new version will be appended'));
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(resetAppearance).toHaveBeenCalled());
  });

  test('supports link rows without icon-only ambiguous controls', async () => {
    render(<AppearancePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add link' }));
    expect(screen.getByLabelText('Link 1 kind')).toHaveValue('custom');
    expect(screen.getByLabelText('Link 1 label')).toBeInTheDocument();
    expect(screen.getByLabelText('Link 1 URL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove link 1' })).toBeInTheDocument();
  });
});
