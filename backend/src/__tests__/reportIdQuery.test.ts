import { isReportIdQuery } from '../services/ReportManager';

describe('isReportIdQuery', () => {
  test('accepts 8-char short ids and full/partial UUIDs', () => {
    expect(isReportIdQuery('e21beca0')).toBe(true);
    expect(isReportIdQuery('E21BECA0')).toBe(true);
    expect(isReportIdQuery(' e21beca0 ')).toBe(true);
    expect(isReportIdQuery('e21beca0-b207')).toBe(true);
    expect(isReportIdQuery('e21beca0-b207-432d-a269-554e51a48382')).toBe(true);
  });

  test('rejects normal search terms and wildcard smuggling', () => {
    expect(isReportIdQuery('dashboard')).toBe(false);
    expect(isReportIdQuery('deadbeef notes')).toBe(false);
    expect(isReportIdQuery('e21beca')).toBe(false);      // 7 chars: too short
    expect(isReportIdQuery('e21beca0%')).toBe(false);    // LIKE wildcard
    expect(isReportIdQuery('e21beca0_b207')).toBe(false);
    expect(isReportIdQuery('12345678-not-hex')).toBe(false);
  });
});
