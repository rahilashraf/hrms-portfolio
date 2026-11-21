import { DocumentRecordPage } from '../../../../../../components/documents/document-record-page';

export default async function DocumentRecordRoute({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = await params;
  return <DocumentRecordPage documentId={documentId} />;
}
