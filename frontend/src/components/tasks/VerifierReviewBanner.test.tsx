// @vitest-environment jsdom
// Card 41e24358 (design ba22fd01 Part 5; E284): the Review banner.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { VerifierReviewBanner, verifierBannerText } from './VerifierReviewBanner';

afterEach(() => { cleanup(); });

describe('the Review banner', () => {
  test('shows on a Review card whose Verifier cannot judge it, naming the arm', () => {
    render(<VerifierReviewBanner task={{ status: 'review', verifierUsability: { usable: false, failedArm: 'chain', principalId: 'p' } }}
      verifierName="Main" />);
    expect(screen.getByRole('status')).toHaveTextContent('No usable Verifier: Main is disabled or has no live credential');
    expect(screen.queryByRole('button', { name: 'Set Verifier' })).toBeNull();
  });

  test('is absent when the Verifier is usable, when the card is not in Review, or when the predicate was not read', () => {
    const { container, rerender } = render(
      <VerifierReviewBanner task={{ status: 'review', verifierUsability: { usable: true, principalId: 'p' } }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<VerifierReviewBanner task={{ status: 'in-progress', verifierUsability: { usable: false, failedArm: 'none', principalId: null } }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<VerifierReviewBanner task={{ status: 'review', verifierUsability: null }} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('offers Set Verifier only when the caller may assign roles', () => {
    const onSetVerifier = vi.fn();
    render(<VerifierReviewBanner task={{ status: 'review', verifierUsability: { usable: false, failedArm: 'none', principalId: null } }}
      onSetVerifier={onSetVerifier} />);
    expect(screen.getByRole('status')).toHaveTextContent('No usable Verifier: none set');
    fireEvent.click(screen.getByRole('button', { name: 'Set Verifier' }));
    expect(onSetVerifier).toHaveBeenCalledTimes(1);
  });

  test('every arm has its own sentence', () => {
    expect(verifierBannerText('principal', 'Ada')).toBe('No usable Verifier: Ada is not active');
    expect(verifierBannerText('scope', 'Ada')).toBe('No usable Verifier: Ada lacks tasks:write');
    expect(verifierBannerText('independence', 'Ada')).toBe('No usable Verifier: Ada is also the Assignee');
    expect(verifierBannerText('chain', null)).toBe('No usable Verifier: the Verifier is disabled or has no live credential');
  });
});
