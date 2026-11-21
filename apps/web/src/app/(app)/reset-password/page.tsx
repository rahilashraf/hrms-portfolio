'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PasswordTokenForm } from '../../../components/auth/password-token-form';
import { readFragmentToken, removeTokenFragment } from '../../../lib/auth/recovery-token';
import { resetPassword } from '../../../lib/auth/api-client';

export default function ResetPasswordPage() {
  const [token] = useState(readFragmentToken);

  useEffect(() => {
    removeTokenFragment();
  }, []);

  return (
    <>
      <PasswordTokenForm
        title="Choose a new password"
        description="Use a passphrase of 12 to 128 characters."
        submitLabel="Reset password"
        token={token}
        onSubmit={async (value, password) => {
          await resetPassword(value, password);
        }}
      />
      <div className="mx-auto -mt-6 mb-8 w-full max-w-md px-8">
        <Link className="text-sm font-medium text-indigo-700 hover:underline" href="/login">
          Back to sign in
        </Link>
      </div>
    </>
  );
}
