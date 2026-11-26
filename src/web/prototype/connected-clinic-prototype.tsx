import { Preferences } from '@ui-sdk/react/preferences'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { workbenchPreferences } from '../workbench/workbench-preferences'
import { createClinicFeedback } from './clinic-feedback'
import { createClinicActions, createClinicStore } from './connected-clinic-actions'
import './connected-clinic-prototype.css'
import { ConnectedClinicStudio } from './connected-clinic-studio'
import { createInitialClinicState } from './connected-clinic-store'
import { PatientMobileApp } from './patient-mobile-app'

const PHONE_QUERY = '(max-width: 767px)'

function usePhoneViewport() {
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia(PHONE_QUERY)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  )
}

export function ConnectedClinicPrototype() {
  const [feedback] = useState(createClinicFeedback)
  const [store] = useState(() => createClinicStore(createInitialClinicState()))
  const [actions] = useState(() => createClinicActions(store, feedback))
  const state = useSyncExternalStore(store.subscribe, store.get, store.get)
  const phone = usePhoneViewport()

  useEffect(
    () => () => {
      for (const toaster of [feedback.toast.patient, feedback.toast.staff, feedback.notify.patient, feedback.notify.staff]) {
        toaster.dismiss()
      }
    },
    [feedback],
  )

  return (
    <Preferences preferences={workbenchPreferences}>
      <div className="cc-proto-root">
        {phone ? (
          <PatientMobileApp key={state.currentPatient} state={state} actions={actions} feedback={feedback} mode="fullscreen" />
        ) : (
          <ConnectedClinicStudio state={state} actions={actions} feedback={feedback} />
        )}
      </div>
    </Preferences>
  )
}
