import { fireEvent } from "@testing-library/react-native"
import { ActivityItem_Test_Query } from "__generated__/ActivityItem_Test_Query.graphql"
import { navigate } from "app/navigation/navigate"
import { flushPromiseQueue } from "app/tests/flushPromiseQueue"
import { mockTrackEvent } from "app/tests/globallyMockedStuff"
import { renderWithHookWrappersTL } from "app/tests/renderWithWrappers"
import { resolveMostRecentRelayOperation } from "app/tests/resolveMostRecentRelayOperation"
import { extractNodes } from "app/utils/extractNodes"
import { graphql, useLazyLoadQuery } from "react-relay"
import { createMockEnvironment } from "relay-test-utils"
import { ActivityItem } from "./ActivityItem"

const targetUrl = "/artist/banksy/works-for-sale?sort=-published_at"
const alertTargetUrl =
  "/artist/banksy/works-for-sale?search_criteria_id=searchCriteriaId&sort=-published_at"

jest.unmock("react-relay")

describe("ActivityItem", () => {
  let mockEnvironment: ReturnType<typeof createMockEnvironment>

  beforeEach(() => {
    mockEnvironment = createMockEnvironment()
  })

  const TestRenderer = () => {
    const data = useLazyLoadQuery<ActivityItem_Test_Query>(
      graphql`
        query ActivityItem_Test_Query {
          notificationsConnection(first: 1) {
            edges {
              node {
                ...ActivityItem_item
              }
            }
          }
        }
      `,
      {}
    )
    const items = extractNodes(data.notificationsConnection)

    return <ActivityItem item={items[0]} />
  }

  it("should the basic info", async () => {
    const { getByText } = renderWithHookWrappersTL(<TestRenderer />, mockEnvironment)

    resolveMostRecentRelayOperation(mockEnvironment, {
      Notification: () => notification,
    })
    await flushPromiseQueue()

    expect(getByText("Notification Title")).toBeTruthy()
    expect(getByText("Notification Message")).toBeTruthy()
  })

  it("should render the formatted publication date", async () => {
    const { getByText } = renderWithHookWrappersTL(<TestRenderer />, mockEnvironment)

    resolveMostRecentRelayOperation(mockEnvironment, {
      Notification: () => notification,
    })
    await flushPromiseQueue()

    expect(getByText("2 days ago")).toBeTruthy()
  })

  it("should render artwork images", async () => {
    const { getAllByLabelText } = renderWithHookWrappersTL(<TestRenderer />, mockEnvironment)

    resolveMostRecentRelayOperation(mockEnvironment, {
      Notification: () => notification,
    })
    await flushPromiseQueue()

    expect(getAllByLabelText("Activity Artwork Image")).toHaveLength(4)
  })

  it("should track event when an item is tapped", async () => {
    const { getByText } = renderWithHookWrappersTL(<TestRenderer />, mockEnvironment)

    resolveMostRecentRelayOperation(mockEnvironment, {
      Notification: () => notification,
    })
    await flushPromiseQueue()

    fireEvent.press(getByText("Notification Title"))

    expect(mockTrackEvent.mock.calls[0]).toMatchInlineSnapshot(`
      Array [
        Object {
          "action": "clickedActivityPanelNotificationItem",
          "notification_type": "ARTWORK_PUBLISHED",
        },
      ]
    `)
  })

  it("should pass predefined props when", async () => {
    const { getByText } = renderWithHookWrappersTL(<TestRenderer />, mockEnvironment)

    resolveMostRecentRelayOperation(mockEnvironment, {
      Notification: () => notification,
    })
    await flushPromiseQueue()

    fireEvent.press(getByText("Notification Title"))

    expect(navigate).toHaveBeenCalledWith(targetUrl, {
      passProps: {
        predefinedFilters: [
          {
            displayText: "Recently Added",
            paramName: "sort",
            paramValue: "-published_at",
          },
        ],
      },
    })
  })

  it("should pass search criteria id prop", async () => {
    const { getByText } = renderWithHookWrappersTL(<TestRenderer />, mockEnvironment)

    resolveMostRecentRelayOperation(mockEnvironment, {
      Notification: () => ({
        ...notification,
        targetHref: alertTargetUrl,
      }),
    })
    await flushPromiseQueue()

    fireEvent.press(getByText("Notification Title"))

    expect(navigate).toHaveBeenCalledWith(alertTargetUrl, {
      passProps: {
        searchCriteriaID: "searchCriteriaId",
        predefinedFilters: [
          {
            displayText: "Recently Added",
            paramName: "sort",
            paramValue: "-published_at",
          },
        ],
      },
    })
  })

  describe("Unread notification indicator", () => {
    it("should NOT be rendered by default", async () => {
      const { queryByLabelText } = renderWithHookWrappersTL(<TestRenderer />, mockEnvironment)

      resolveMostRecentRelayOperation(mockEnvironment, {
        Notification: () => notification,
      })
      await flushPromiseQueue()

      const indicator = queryByLabelText("Unread notification indicator")
      expect(indicator).toBeNull()
    })

    it("should be rendered when notification is unread", async () => {
      const { getByLabelText } = renderWithHookWrappersTL(<TestRenderer />, mockEnvironment)

      resolveMostRecentRelayOperation(mockEnvironment, {
        Notification: () => ({
          ...notification,
          isUnread: true,
        }),
      })
      await flushPromiseQueue()

      const indicator = getByLabelText("Unread notification indicator")
      expect(indicator).toBeTruthy()
    })
  })

  describe("Notification type", () => {
    it("should NOT be rendered by default", async () => {
      const { queryByLabelText } = renderWithHookWrappersTL(<TestRenderer />, mockEnvironment)

      resolveMostRecentRelayOperation(mockEnvironment, {
        Notification: () => notification,
      })
      await flushPromiseQueue()

      const label = queryByLabelText(/Notification type: .+/i)
      expect(label).toBeNull()
    })

    it("should render 'Alert'", async () => {
      const { getByLabelText } = renderWithHookWrappersTL(<TestRenderer />, mockEnvironment)

      resolveMostRecentRelayOperation(mockEnvironment, {
        Notification: () => ({
          ...notification,
          notificationType: "ARTWORK_ALERT",
        }),
      })
      await flushPromiseQueue()

      const label = getByLabelText("Notification type: Alert")
      expect(label).toBeTruthy()
    })
  })
})

const artworks = [
  {
    node: {
      internalID: "artwork-id-one",
      title: "artwork one",
      image: {
        thumb: {
          src: "artwork-image-one",
          srcSet: "artwork-image-one",
        },
      },
    },
  },
  {
    node: {
      internalID: "artwork-id-two",
      title: "artwork two",
      image: {
        thumb: {
          src: "artwork-image-two",
          srcSet: "artwork-image-two",
        },
      },
    },
  },
  {
    node: {
      internalID: "artwork-id-three",
      title: "artwork three",
      image: {
        thumb: {
          src: "artwork-image-three",
          srcSet: "artwork-image-three",
        },
      },
    },
  },
  {
    node: {
      internalID: "artwork-id-four",
      title: "artwork four",
      image: {
        thumb: {
          src: "artwork-image-four",
          srcSet: "artwork-image-four",
        },
      },
    },
  },
]

const notification = {
  title: "Notification Title",
  message: "Notification Message",
  publishedAt: "2 days ago",
  isUnread: false,
  notificationType: "ARTWORK_PUBLISHED",
  targetHref: targetUrl,
  artworksConnection: {
    totalCount: 4,
    edges: artworks,
  },
}
