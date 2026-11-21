import { redirect } from 'next/navigation';

/** Batch 7A: /recruitment has no page of its own — it opens Recruitment administration. */
export default function RecruitmentIndexPage() {
  redirect('/admin/recruitment');
}
