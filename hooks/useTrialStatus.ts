import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/utils/supabase';

export function useTrialStatus() {
  const { user, session } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [trialStatus, setTrialStatus] = useState<{
    isInTrial: boolean;
    trialEndTime: string | null;
  }>({ isInTrial: false, trialEndTime: null });

  useEffect(() => {
    async function checkTrialStatus() {
      if (!user?.id) {
        setIsLoading(false);
        return;
      }

      try {
        // First check if user has an active subscription
        const { data: subscription } = await supabase
          .from('subscriptions')
          .select('status')
          .eq('user_id', user.id)
          .maybeSingle();

        // If user has an active subscription, skip trial creation
        if (subscription?.status === 'active' || subscription?.status === 'trialing') {
          setTrialStatus({
            isInTrial: false,
            trialEndTime: null
          });
          setIsLoading(false);
          return;
        }

        // Check if user has an existing trial
        const { data: trial, error: trialError } = await supabase
          .from('user_trials')
          .select('trial_end_time, is_trial_used')
          .eq('user_id', user.id)
          .maybeSingle();

        if (trialError && trialError.code !== 'PGRST116') { // PGRST116 is "not found" error
          throw trialError;
        }

        if (trial) {
          // Check if trial is still valid
          const now = new Date();
          const endTime = new Date(trial.trial_end_time);
          const isInTrial = !trial.is_trial_used && now < endTime;

          setTrialStatus({
            isInTrial,
            trialEndTime: trial.trial_end_time
          });
        } else {
          // Trial rows are server-written only (RLS); the route starts a 48h trial
          const response = await fetch('/api/user/trial', {
            method: 'POST',
            headers: session?.access_token ? { Authorization: 'Bearer ' + session.access_token } : {},
          });
          if (!response.ok) throw new Error('Failed to start trial');
          const newTrial = await response.json();

          setTrialStatus({
            isInTrial: !newTrial.is_trial_used && new Date() < new Date(newTrial.trial_end_time),
            trialEndTime: newTrial.trial_end_time
          });
        }
      } catch (error) {
        console.error('Error checking trial status:', error);
        // Set default state on error
        setTrialStatus({
          isInTrial: false,
          trialEndTime: null
        });
      } finally {
        setIsLoading(false);
      }
    }

    checkTrialStatus();
  }, [user?.id, session?.access_token]);

  return { ...trialStatus, isLoading };
}