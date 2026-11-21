import { ReportPage } from '../../../../../components/reporting/report-page';

function decoded(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default async function ReportRoute({ params }: { params: Promise<{ reportKey: string }> }) {
  const { reportKey } = await params;
  return <ReportPage reportKey={decoded(reportKey)} />;
}
