import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import type { ApiClient } from './api'
import { getDeviceId } from './storage'
import type { PushRegistrationState } from './types'

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

function projectId(): string | undefined {
  return Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId
}

export async function registerForPush(client: ApiClient): Promise<PushRegistrationState> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('roam-default', {
        name: 'Roam',
        importance: Notifications.AndroidImportance.DEFAULT,
      })
    }

    const existing = await Notifications.getPermissionsAsync()
    let status = existing.status
    if (status !== 'granted') {
      const requested = await Notifications.requestPermissionsAsync()
      status = requested.status
    }
    if (status !== 'granted') return { status: 'denied' }

    const easProjectId = projectId()
    if (!easProjectId) return { status: 'missingProject' }

    const token = (await Notifications.getExpoPushTokenAsync({ projectId: easProjectId })).data
    const deviceId = await getDeviceId(client.origin)
    await client.registerMobileDevice({
      id: deviceId,
      expoPushToken: token,
      appVersion: Constants.expoConfig?.version,
    })
    return { status: 'ready', token }
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}
