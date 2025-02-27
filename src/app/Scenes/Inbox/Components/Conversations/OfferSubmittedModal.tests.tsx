import { act, fireEvent } from "@testing-library/react-native"
import { goBack, navigate } from "app/navigation/navigate"
import { renderWithWrappers } from "app/tests/renderWithWrappers"
import { OfferSubmittedModal } from "./OfferSubmittedModal"

jest.mock("app/navigation/navigate", () => ({
  navigate: jest.fn(),
  goBack: jest.fn(),
}))

let callback: undefined | (([...args]: any) => void)
jest.mock("app/utils/useWebViewEvent", () => ({
  useSetWebViewCallback: (_: string, cb: ([...args]: any) => void) => {
    callback = cb
    return jest.fn()
  },
}))

describe("OfferSubmittedModal", () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it("renders", () => {
    const { getByText } = renderWithWrappers(<OfferSubmittedModal />)
    act(() => callback?.({ orderCode: "1234", message: "Test message" }))

    expect(getByText("Thank you, your offer has been submitted")).toBeTruthy()
    expect(getByText("Negotiation with the gallery will continue in the Inbox.")).toBeTruthy()
    expect(getByText("Offer #1234")).toBeTruthy()
    expect(getByText("Test message")).toBeTruthy()
    expect(goBack).toHaveBeenCalledTimes(1)
  })

  it("onGoToInbox", () => {
    const { getAllByText } = renderWithWrappers(<OfferSubmittedModal />)
    act(() => callback?.({ orderCode: "1234", message: "Test message" }))

    act(() => fireEvent.press(getAllByText("Go to inbox")[0]))
    expect(navigate).toHaveBeenCalledWith("inbox")
  })
})
