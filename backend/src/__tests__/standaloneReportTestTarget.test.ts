import { standaloneReportTestTarget } from './support/standaloneReportTestTarget';
const local = 'postgres://relayhall_test@127.0.0.1:35432/relayhall_report_sponsor_test';
const service = 'postgres://relayhall_ci:relayhall_ci@postgres:5432/relayhall_ci';
test.each(['postgres:', 'postgresql:'])('%s preserves the isolated loopback harness', protocol => {
  expect(standaloneReportTestTarget(local.replace('postgres:', protocol), undefined).hostname).toBe('127.0.0.1');
});
test('exact CI service tuple is admitted only with CI true', () => {
  expect(standaloneReportTestTarget(service, 'true').pathname).toBe('/relayhall_ci');
});
test.each([undefined, '', 'false', '1', 'TRUE'])('CI marker %s cannot admit the service tuple', ci => {
  expect(() => standaloneReportTestTarget(service, ci)).toThrow('Exact disposable Report database target required');
});
test.each([
  undefined, '', 'not a URL',
  'https://relayhall_ci:relayhall_ci@postgres:5432/relayhall_ci',
  service.replace('@postgres:', '@foreign:'),
  service.replace(':5432/', ':5433/'),
  service.replace(':5432/', '/'),
  service.replace('://relayhall_ci:', '://other:'),
  service.replace(/\/relayhall_ci$/, '/relayhall_dev'),
  service.replace(/\/relayhall_ci$/, '/relayhall_tst'),
  service.replace(/\/relayhall_ci$/, '/relayhall_prod'),
  local.replace('/relayhall_report_sponsor_test', '/relayhall_prod'),
])('unsafe or absent target %s refuses before any DB import', raw => {
  expect(() => standaloneReportTestTarget(raw, 'true')).toThrow();
});
