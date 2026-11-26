import { imClient } from './services/im-client'

App({
  onLaunch() {
    // Wait for page-level auth check before connecting IM.
  },
  onHide() {
    imClient.disconnect()
  },
})
