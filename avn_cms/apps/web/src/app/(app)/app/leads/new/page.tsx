import { can } from '@avn-cms/core/policy';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { StudentForm } from './student-form';

export const metadata: Metadata = { title: 'Add student' };

export default async function NewStudentPage() {
  const { ctx } = await requireTenantPage();
  if (!can(ctx, 'student:create')) redirect('/app/leads');
  return (
    <>
      <PageHeader
        title="Add student"
        description="Creates the student and their first lead. Duplicate phone numbers are caught before saving."
      />
      <StudentForm isAdmin={ctx.role === 'TENANT_ADMIN'} />
    </>
  );
}
