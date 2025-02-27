import { ActionType, AuthService, CreatedAccount } from "@artsy/cohesion"
import { appleAuth } from "@invertase/react-native-apple-authentication"
import CookieManager from "@react-native-cookies/cookies"
import { GoogleSignin } from "@react-native-google-signin/google-signin"
import { captureMessage } from "@sentry/react-native"
import { OAuthProvider } from "app/auth/types"
import * as RelayCache from "app/relay/RelayCache"
import { isArtsyEmail } from "app/utils/general"
import { postEventToProviders } from "app/utils/track/providers"
import { action, Action, Computed, computed, StateMapper, thunk, Thunk } from "easy-peasy"
import { capitalize } from "lodash"
import { stringify } from "qs"
import { Platform } from "react-native"
import Config from "react-native-config"
import {
  AccessToken,
  GraphRequest,
  GraphRequestManager,
  LoginManager,
} from "react-native-fbsdk-next"
import Keychain from "react-native-keychain"
import { LegacyNativeModules } from "../NativeModules/LegacyNativeModules"
import { requestPushNotificationsPermission } from "../utils/PushNotification"
import { AuthError } from "./AuthError"
import { getCurrentEmissionState, GlobalStore } from "./GlobalStore"
import type { GlobalStoreModel } from "./GlobalStoreModel"

type BasicHttpMethod = "GET" | "PUT" | "POST" | "DELETE"

const showError = (
  res: any,
  reject: (reason?: any) => void,
  provider: "facebook" | "apple" | "google"
) => {
  const providerName = capitalize(provider)

  if (res.error_description) {
    if (res.error_description.includes("no account linked to oauth token")) {
      const message =
        `Your ${providerName} account is not linked to any Artsy account. ` +
        "Please log in using your email and password if you have an Artsy account, " +
        `or sign up on Artsy using ${providerName}.
        `
      captureMessage("AUTH_FAILURE: " + message)
      reject(new AuthError(message))
      return
    } else {
      const message = "Login attempt failed"
      captureMessage("AUTH_FAILURE: " + message)
      reject(new AuthError(message))
      return
    }
  }
}

type SignInStatus = "failure" | "success" | "otp_missing" | "on_demand_otp_missing" | "invalid_otp"

const handleSignUpError = ({
  errorObject,
  oauthProvider,
}: {
  errorObject: any
  oauthProvider: OAuthProvider
}) => {
  let message = ""
  let existingProviders: OAuthProvider[] = []
  const providerName = capitalize(oauthProvider)

  if (errorObject?.error === "User Already Exists") {
    message = `Your ${
      providerName === "Email" ? "" : providerName
    } email account is linked to an Artsy user account please Log in using your email and password instead.`
    const authentications = (errorObject?.providers ?? []) as string[]
    if (errorObject?.has_password && oauthProvider !== "email") {
      existingProviders = ["email"]
    }
    existingProviders = [
      ...existingProviders,
      ...(authentications.map((p) => p.toLowerCase()) as OAuthProvider[]),
    ]
  } else if (errorObject?.error === "Another Account Already Linked") {
    message =
      `Your ${providerName} account is already linked to another Artsy account. ` +
      `Try logging in with ${providerName}.`
  } else if (errorObject.message && errorObject.message.match("Unauthorized source IP address")) {
    message = `You could not create an account because your IP address was blocked by ${providerName}`
  } else {
    message = "Failed to sign up"
  }

  captureMessage("AUTH_SIGN_UP_FAILURE: " + message)

  return {
    message,
    existingProviders,
  }
}
interface EmailOAuthParams {
  oauthProvider: "email"
  email: string
  password: string
  otp?: string
}
interface FacebookOAuthParams {
  oauthProvider: "facebook"
  accessToken: string
}
interface GoogleOAuthParams {
  oauthProvider: "google"
  accessToken: string
}
interface AppleOAuthParams {
  oauthProvider: "apple"
  idToken: string
  appleUid: string
}

interface SignUpParams {
  email: string
  name: string
  agreedToReceiveEmails: boolean
}

type OAuthParams = EmailOAuthParams | FacebookOAuthParams | GoogleOAuthParams | AppleOAuthParams

type OnboardingState = "none" | "incomplete" | "complete"

export interface AuthPromiseResolveType {
  success: boolean
}
export interface AuthPromiseRejectType {
  error?: string
  message: string
  meta?: {
    email: string
    provider: OAuthProvider
    name?: string
    existingProviders?: OAuthProvider[]
    oauthToken?: string
    idToken?: string
    appleUid?: string
  }
}

export interface AuthModel {
  // State
  sessionState: {
    isLoading: boolean
  }
  userID: string | null
  userAccessToken: string | null
  userAccessTokenExpiresIn: string | null
  xAppToken: string | null
  xApptokenExpiresIn: string | null
  onboardingState: OnboardingState
  userEmail: string | null
  previousSessionUserID: string | null

  userHasArtsyEmail: Computed<this, boolean, GlobalStoreModel>

  // Actions
  setState: Action<this, Partial<StateMapper<this, "1">>>
  getXAppToken: Thunk<this, void, {}, GlobalStoreModel, Promise<string>>
  getUser: Thunk<this, { accessToken: string }, {}, GlobalStoreModel>
  userExists: Thunk<this, { email: string }, {}, GlobalStoreModel>
  signIn: Thunk<
    this,
    { email: string; onboardingState?: OnboardingState; onSignIn?: () => void } & OAuthParams,
    {},
    GlobalStoreModel,
    Promise<SignInStatus>
  >
  signUp: Thunk<
    this,
    SignUpParams & OAuthParams,
    {},
    GlobalStoreModel,
    Promise<AuthPromiseResolveType & AuthPromiseRejectType>
  >
  authFacebook: Thunk<
    this,
    | { signInOrUp: "signIn"; onSignIn?: () => void }
    | { signInOrUp: "signUp"; agreedToReceiveEmails: boolean },
    {},
    GlobalStoreModel,
    Promise<AuthPromiseResolveType>
  >
  authGoogle: Thunk<
    this,
    | { signInOrUp: "signIn"; onSignIn?: () => void }
    | { signInOrUp: "signUp"; agreedToReceiveEmails: boolean },
    {},
    GlobalStoreModel,
    Promise<AuthPromiseResolveType>
  >
  authApple: Thunk<
    this,
    { agreedToReceiveEmails?: boolean; onSignIn?: () => void },
    {},
    GlobalStoreModel,
    Promise<AuthPromiseResolveType>
  >
  forgotPassword: Thunk<this, { email: string }, {}, GlobalStoreModel, Promise<boolean>>
  gravityUnauthenticatedRequest: Thunk<
    this,
    {
      path: string
      method?: BasicHttpMethod
      body?: object
      headers?: RequestInit["headers"]
    },
    {},
    GlobalStoreModel,
    ReturnType<typeof fetch>
  >
  signOut: Thunk<this>
}

const clientKey = __DEV__ ? Config.ARTSY_DEV_API_CLIENT_KEY : Config.ARTSY_PROD_API_CLIENT_KEY
const clientSecret = __DEV__
  ? Config.ARTSY_DEV_API_CLIENT_SECRET
  : Config.ARTSY_PROD_API_CLIENT_SECRET

export const getAuthModel = (): AuthModel => ({
  sessionState: {
    isLoading: false,
  },
  userID: null,
  userAccessToken: null,
  userAccessTokenExpiresIn: null,
  xAppToken: null,
  xApptokenExpiresIn: null,
  onboardingState: "none",
  userEmail: null,
  previousSessionUserID: null,
  userHasArtsyEmail: computed((state) => isArtsyEmail(state.userEmail ?? "")),

  setState: action((state, payload) => Object.assign(state, payload)),
  getXAppToken: thunk(async (actions, _payload, context) => {
    const xAppToken = context.getState().xAppToken
    if (xAppToken) {
      // TODO: handle expiry
      return xAppToken
    }
    const gravityBaseURL = context.getStoreState().artsyPrefs.environment.strings.gravityURL
    const tokenURL = `${gravityBaseURL}/api/v1/xapp_token?${stringify({
      client_id: clientKey,
      client_secret: clientSecret,
    })}`
    const result = await fetch(tokenURL, {
      headers: {
        "User-Agent": getCurrentEmissionState().userAgent,
      },
    })
    // TODO: check status
    const json = (await result.json()) as {
      xapp_token: string
      expires_in: string
    }
    if (json.xapp_token) {
      actions.setState({
        xAppToken: json.xapp_token,
        xApptokenExpiresIn: json.expires_in,
      })
      return json.xapp_token
    }
    throw new Error("Unable to get x-app-token from " + tokenURL)
  }),
  gravityUnauthenticatedRequest: thunk(async (actions, payload, context) => {
    const gravityBaseURL = context.getStoreState().artsyPrefs.environment.strings.gravityURL
    const xAppToken = await actions.getXAppToken()

    return await fetch(`${gravityBaseURL}${payload.path}`, {
      method: payload.method || "GET",
      headers: {
        "X-Xapp-Token": xAppToken,
        Accept: "application/json",
        "User-Agent": getCurrentEmissionState().userAgent,
        ...payload.headers,
      },
      body: payload.body ? JSON.stringify(payload.body) : undefined,
    })
  }),
  userExists: thunk(async (actions, { email }) => {
    const result = await actions.gravityUnauthenticatedRequest({
      path: `/api/v1/user?${stringify({ email })}`,
    })
    if (result.status === 200) {
      return true
    } else if (result.status === 404) {
      return false
    } else {
      throw new Error(JSON.stringify(await result.json()))
    }
  }),
  forgotPassword: thunk(async (actions, { email }) => {
    const result = await actions.gravityUnauthenticatedRequest({
      path: `/api/v1/users/send_reset_password_instructions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        email,
      },
    })

    // For security purposes we don't want to disclose when a user is not found
    // this is indicated by 400 on gravity side, treat as success
    if (result.ok || result.status === 400) {
      return true
    }
    return false
  }),
  getUser: thunk(async (actions, { accessToken }) => {
    return await (
      await actions.gravityUnauthenticatedRequest({
        path: `/api/v1/me`,
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-ACCESS-TOKEN": accessToken,
        },
      })
    ).json()
  }),
  signIn: thunk(async (actions, args, store) => {
    const { oauthProvider, email, onboardingState, onSignIn } = args

    const grantTypeMap = {
      facebook: "oauth_token",
      google: "oauth_token",
      apple: "apple_uid",
      email: "credentials",
    }

    const result = await actions.gravityUnauthenticatedRequest({
      path: `/oauth2/access_token`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        email,
        oauth_provider: oauthProvider,
        otp_attempt: oauthProvider === "email" ? args?.otp ?? undefined : undefined,
        password: oauthProvider === "email" ? args.password : undefined,
        oauth_token:
          oauthProvider === "facebook" || oauthProvider === "google" ? args.accessToken : undefined,
        apple_uid: oauthProvider === "apple" ? args.appleUid : undefined,
        id_token: oauthProvider === "apple" ? args.idToken : undefined,
        grant_type: grantTypeMap[oauthProvider],
        client_id: clientKey,
        client_secret: clientSecret,
        scope: "offline_access",
      },
    })

    if (result.status === 201) {
      const { expires_in, access_token: userAccessToken } = await result.json()
      const user = await actions.getUser({ accessToken: userAccessToken })

      actions.setState({
        userAccessToken,
        userAccessTokenExpiresIn: expires_in,
        userID: user.id,
        userEmail: email,
        onboardingState: onboardingState ?? "complete",
      })

      if (oauthProvider === "email") {
        Keychain.setInternetCredentials(
          store.getStoreState().artsyPrefs.environment.strings.webURL.slice("https://".length),
          email,
          args.password
        )
      }

      if (user.id !== store.getState().previousSessionUserID) {
        const storeActions = store.getStoreActions()

        storeActions.search.clearRecentSearches()
        storeActions.recentPriceRanges.clearAllPriceRanges()
      }

      postEventToProviders(tracks.loggedIn(oauthProvider))

      if (!onboardingState || onboardingState === "complete" || onboardingState === "none") {
        requestPushNotificationsPermission()
      }

      onSignIn?.()

      // Setting up user prefs from gravity after successsfull login.
      GlobalStore.actions.userPrefs.fetchRemoteUserPrefs()

      return "success"
    }

    const { error_description: errorDescription } = await result.json()

    switch (errorDescription) {
      case "missing two-factor authentication code":
        return "otp_missing"
      case "missing on-demand authentication code":
        return "on_demand_otp_missing"
      case "invalid two-factor authentication code":
        return "invalid_otp"

      default:
        return "failure"
    }
  }),
  signUp: thunk(async (actions, args) => {
    const { oauthProvider, email, name, agreedToReceiveEmails } = args
    const result = await actions.gravityUnauthenticatedRequest({
      path: `/api/v1/user`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        provider: oauthProvider,
        email,
        name,

        password: oauthProvider === "email" ? args.password : undefined,
        oauth_token:
          oauthProvider === "facebook" || oauthProvider === "google" ? args.accessToken : undefined,
        apple_uid: oauthProvider === "apple" ? args.appleUid : undefined,
        id_token: oauthProvider === "apple" ? args.idToken : undefined,

        agreed_to_receive_emails: agreedToReceiveEmails,
        accepted_terms_of_service: true,
      },
    })

    // The user account has been successfully created
    if (result.status === 201) {
      postEventToProviders(tracks.createdAccount({ signUpMethod: oauthProvider }))

      switch (oauthProvider) {
        case "facebook":
        case "google":
          await actions.signIn({
            oauthProvider,
            email,
            accessToken: args.accessToken,
            onboardingState: "incomplete",
          })
          break
        case "apple":
          await actions.signIn({
            oauthProvider,
            email,
            idToken: args.idToken,
            appleUid: args.appleUid,
            onboardingState: "incomplete",
          })
          break
        case "email":
          await actions.signIn({
            oauthProvider,
            email,
            password: args.password,
            onboardingState: "incomplete",
          })
          break
        default:
          assertNever(oauthProvider)
      }

      // Setting up user prefs from gravity after successsfull registration.
      GlobalStore.actions.userPrefs.fetchRemoteUserPrefs()

      return { success: true, message: "" }
    }

    const resultJson = await result.json()

    const { message, existingProviders } = handleSignUpError({
      errorObject: resultJson,
      oauthProvider,
    })

    const { accessToken } = args as SignUpParams & (FacebookOAuthParams | GoogleOAuthParams)
    const { appleUid, idToken } = args as SignUpParams & AppleOAuthParams
    return {
      success: false,
      error: resultJson?.error,
      message,
      meta: {
        existingProviders: existingProviders.length ? existingProviders : undefined,
        email,
        oauthToken: accessToken,
        appleUid,
        idToken,
        provider: oauthProvider,
      },
    }
  }),
  authFacebook: thunk(async (actions, options) => {
    return await new Promise<AuthPromiseResolveType>(async (resolve, reject) => {
      try {
        const { declinedPermissions, isCancelled } = await LoginManager.logInWithPermissions([
          "public_profile",
          "email",
        ])

        if (declinedPermissions?.includes("email")) {
          reject(
            new AuthError("Please allow the use of email to continue.", "Email Permission Declined")
          )
          return
        }
        const accessToken = !isCancelled && (await AccessToken.getCurrentAccessToken())
        if (!accessToken) {
          reject(new AuthError("Could not log in"))
          return
        }

        const responseFacebookInfoCallback = async (error: any | null, result: any | null) => {
          if (error) {
            reject(new AuthError("Error fetching facebook data", error))
            return
          }

          if (!result || !result.email) {
            reject(
              new AuthError(
                "There is no email associated with your Facebook account. Please log in using your email and password instead."
              )
            )
            return
          }

          if (options.signInOrUp === "signUp") {
            const resultGravitySignUp = await actions.signUp({
              email: result.email as string,
              name: result.name as string,
              accessToken: accessToken.accessToken,
              oauthProvider: "facebook",
              agreedToReceiveEmails: options.agreedToReceiveEmails,
            })

            if (resultGravitySignUp.success) {
              resolve({ success: true })
              return
            } else {
              reject(
                new AuthError(
                  resultGravitySignUp.message,
                  resultGravitySignUp.error,
                  resultGravitySignUp.meta
                )
              )
              return
            }
          }

          if (options.signInOrUp === "signIn") {
            // we need to get X-ACCESS-TOKEN before actual sign in
            const resultGravityAccessToken = await actions.gravityUnauthenticatedRequest({
              path: `/oauth2/access_token`,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: {
                oauth_provider: "facebook",
                oauth_token: accessToken.accessToken,
                client_id: clientKey,
                client_secret: clientSecret,
                grant_type: "oauth_token",
                scope: "offline_access",
              },
            })

            if (resultGravityAccessToken.status === 201) {
              const { access_token: userAccessToken } = await resultGravityAccessToken.json() // here's the X-ACCESS-TOKEN we needed now we can get user's email and sign in
              const { email } = await actions.getUser({ accessToken: userAccessToken })
              const resultGravitySignIn = await actions.signIn({
                oauthProvider: "facebook",
                email,
                accessToken: accessToken.accessToken,
                onSignIn: options.onSignIn,
              })

              if (resultGravitySignIn) {
                resolve({ success: true })
                return
              } else {
                reject(new AuthError("Could not log in"))
                return
              }
            } else {
              const res = await resultGravityAccessToken.json()
              showError(res, reject, "facebook")
            }
          }
        }

        // get info from facebook
        const infoRequest = new GraphRequest(
          "/me",
          {
            accessToken: accessToken.accessToken,
            parameters: {
              fields: {
                string: "email,name",
              },
            },
          },
          responseFacebookInfoCallback
        )
        new GraphRequestManager().addRequest(infoRequest).start()
      } catch (e) {
        if (e instanceof Error) {
          if (e.message === "User logged in as different Facebook user.") {
            // odd and hopefully shouldn't happen often
            // if the user has a valid session with another account
            // and tries to log in with a new account they will hit this error
            // log them out and try again
            LoginManager.logOut()
            GlobalStore.actions.auth.authFacebook(options)
          }

          reject(new AuthError("Error logging in with facebook", e.message))
          return
        }
        reject(new AuthError("Error logging in with facebook"))
        return
      }
    })
  }),
  authGoogle: thunk(async (actions, options) => {
    return await new Promise<AuthPromiseResolveType>(async (resolve, reject) => {
      try {
        if (!(await GoogleSignin.hasPlayServices())) {
          reject(new AuthError("Play services are not available."))
          return
        }
        const userInfo = await GoogleSignin.signIn()
        const accessToken = (await GoogleSignin.getTokens()).accessToken

        if (options.signInOrUp === "signUp") {
          const resultGravitySignUp = userInfo.user.name
            ? await actions.signUp({
                email: userInfo.user.email,
                name: userInfo.user.name,
                accessToken,
                oauthProvider: "google",
                agreedToReceiveEmails: options.agreedToReceiveEmails,
              })
            : { success: false, message: "missing name in google's userInfo" }

          if (resultGravitySignUp.success) {
            resolve({ success: true })
            return
          } else {
            reject(
              new AuthError(
                resultGravitySignUp.message,
                resultGravitySignUp.error,
                resultGravitySignUp.meta
              )
            )
            return
          }
        }

        if (options.signInOrUp === "signIn") {
          // we need to get X-ACCESS-TOKEN before actual sign in
          const resultGravityAccessToken = await actions.gravityUnauthenticatedRequest({
            path: `/oauth2/access_token`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: {
              oauth_provider: "google",
              oauth_token: accessToken,
              client_id: clientKey,
              client_secret: clientSecret,
              grant_type: "oauth_token",
              scope: "offline_access",
            },
          })

          if (resultGravityAccessToken.status === 201) {
            const { access_token: userAccessToken } = await resultGravityAccessToken.json() // here's the X-ACCESS-TOKEN we needed now we can get user's email and sign in
            const { email } = await actions.getUser({ accessToken: userAccessToken })

            const resultGravitySignIn = await actions.signIn({
              oauthProvider: "google",
              email,
              accessToken,
              onSignIn: options.onSignIn,
            })

            if (resultGravitySignIn) {
              resolve({ success: true })
              return
            } else {
              reject(new AuthError("Could not log in"))
              return
            }
          } else {
            const res = await resultGravityAccessToken.json()
            showError(res, reject, "google")
          }
        }
      } catch (e) {
        if (e instanceof Error) {
          if (e.message === "DEVELOPER_ERROR") {
            reject(
              new AuthError(
                "Google auth does not work in firebase beta, try again in a playstore beta",
                e.message
              )
            )
            return
          }
          reject(new AuthError("Error logging in with google", e.message))
          return
        }
        reject(new AuthError("Error logging in with google"))
        return
      }
    })
  }),
  authApple: thunk(async (actions, { agreedToReceiveEmails, onSignIn }) => {
    return await new Promise<AuthPromiseResolveType>(async (resolve, reject) => {
      // we cannot have separated logic for sign in and sign up with apple, as with google or facebook,
      // because apple returns email only on the FIRST auth attempt, so we run sign up and sign in one by one
      let signInOrUp: "signIn" | "signUp" = "signUp"

      const userInfo = await appleAuth
        .performRequest({
          requestedOperation: appleAuth.Operation.LOGIN,
          requestedScopes: [appleAuth.Scope.EMAIL, appleAuth.Scope.FULL_NAME],
        })
        .catch(() => {
          // Use canceled apple auth
          actions.setState({ sessionState: { isLoading: false } })
        })

      if (!userInfo) {
        return
      }
      const idToken = userInfo.identityToken
      if (!idToken) {
        reject(new AuthError("Failed to authenticate using apple sign in"))
        return
      }
      const appleUid = userInfo.user

      if (signInOrUp === "signUp") {
        const firstName = userInfo.fullName?.givenName ? userInfo.fullName.givenName : ""
        const lastName = userInfo.fullName?.familyName ? userInfo.fullName.familyName : ""

        const resultGravitySignUp = userInfo.email
          ? await actions.signUp({
              email: userInfo.email,
              name: `${firstName} ${lastName}`.trim(),
              appleUid,
              idToken,
              oauthProvider: "apple",
              agreedToReceiveEmails: !!agreedToReceiveEmails,
            })
          : {
              success: false,
              error: "Apple UserInfo Email Is Null",
              message: "missing email in apple's userInfo",
            }

        if (resultGravitySignUp.success) {
          resolve(resultGravitySignUp)
          return
        }
        const shouldSignIn =
          resultGravitySignUp.error === "Another Account Already Linked" ||
          // because userinfo.email is returned only the first time
          resultGravitySignUp.error === "Apple UserInfo Email Is Null"

        if (shouldSignIn) {
          signInOrUp = "signIn"
        } else {
          reject(
            new AuthError(
              resultGravitySignUp.message,
              resultGravitySignUp.error,
              resultGravitySignUp.meta
            )
          )
          return
        }
      }

      if (signInOrUp === "signIn") {
        // we need to get X-ACCESS-TOKEN before actual sign in
        const resultGravityAccessToken = await actions.gravityUnauthenticatedRequest({
          path: `/oauth2/access_token`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: {
            oauth_provider: "apple",
            apple_uid: appleUid,
            id_token: idToken,
            client_id: clientKey,
            client_secret: clientSecret,
            grant_type: "apple_uid",
            scope: "offline_access",
          },
        })

        if (resultGravityAccessToken.status === 201) {
          const { access_token: userAccessToken } = await resultGravityAccessToken.json() // here's the X-ACCESS-TOKEN we needed now we can get user's email and sign in
          const { email } = await actions.getUser({ accessToken: userAccessToken })

          const resultGravitySignIn = await actions.signIn({
            oauthProvider: "apple",
            email,
            appleUid,
            idToken,
            onSignIn,
          })

          if (resultGravitySignIn) {
            resolve({ success: true })
            return
          } else {
            reject(new AuthError("Could not log in"))
            return
          }
        } else {
          const res = await resultGravityAccessToken.json()
          showError(res, reject, "apple")
        }
      }
    })
  }),
  signOut: thunk(async () => {
    const signOutGoogle = async () => {
      try {
        const isSignedIn = await GoogleSignin.isSignedIn()
        if (isSignedIn) {
          await GoogleSignin.revokeAccess()
          await GoogleSignin.signOut()
        }
      } catch (error) {
        console.log("Failed to signout from Google")
        console.error(error)
      }
    }

    await Promise.all([
      Platform.OS === "ios"
        ? await LegacyNativeModules.ArtsyNativeModule.clearUserData()
        : Promise.resolve(),
      await signOutGoogle(),
      LoginManager.logOut(),
      CookieManager.clearAll(),
      RelayCache.clearAll(),
    ])
  }),
})

const tracks = {
  createdAccount: ({ signUpMethod }: { signUpMethod: AuthService }): Partial<CreatedAccount> => ({
    action: ActionType.createdAccount,
    service: signUpMethod,
  }),
  loggedIn: (service: AuthService) => ({
    action: ActionType.successfullyLoggedIn,
    service,
  }),
}
