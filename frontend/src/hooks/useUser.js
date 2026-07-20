import { useUser as useClerkUser } from '@clerk/clerk-react'

export function useUser() {
  const { user, isLoaded, isSignedIn } = useClerkUser()
  return {
    user,
    isLoaded,
    isSignedIn,
    plan: 'FREE',
    daysLeft: null,
    isAdmin: false,
  }
}
