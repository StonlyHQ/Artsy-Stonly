import { OtherCollectionsRail_collectionGroup$data } from "__generated__/OtherCollectionsRail_collectionGroup.graphql"
import { CardRailFlatList } from "app/Components/Home/CardRailFlatList"
import { navigate } from "app/navigation/navigate"
import { Spacer, Text, TextProps } from "palette"
import React, { useRef } from "react"
import { TouchableOpacity, View } from "react-native"
import { createFragmentContainer, graphql } from "react-relay"

export interface OtherCollectionsRailProps {
  collectionGroup: OtherCollectionsRail_collectionGroup$data
}

export const CollectionGroupMemberPill: React.FC<Partial<TextProps>> = (props) => (
  <Text
    variant="sm"
    px={3}
    py={2}
    bg="black10"
    // @ts-ignore
    style={{ overflow: "hidden", borderRadius: "6px" }}
    {...props}
  />
)

export const OtherCollectionsRail: React.FC<OtherCollectionsRailProps> = ({
  collectionGroup: { name, members },
}) => {
  const ref = useRef<View | null>(null)

  return (
    <View ref={ref}>
      <Text variant="sm-display" m={2}>
        {name}
      </Text>

      <CardRailFlatList
        data={members}
        initialNumToRender={3}
        keyExtractor={({ id }) => id}
        ItemSeparatorComponent={() => <Spacer mr={0.5} />}
        renderItem={({ item: { slug, title } }) => {
          return (
            <TouchableOpacity
              onPress={() => {
                navigate(`/collection/${slug}`)
              }}
            >
              <CollectionGroupMemberPill>{title}</CollectionGroupMemberPill>
            </TouchableOpacity>
          )
        }}
      />
    </View>
  )
}

export const OtherCollectionsRailContainer = createFragmentContainer(OtherCollectionsRail, {
  collectionGroup: graphql`
    fragment OtherCollectionsRail_collectionGroup on MarketingCollectionGroup {
      groupType
      name
      members {
        id
        slug
        title
      }
    }
  `,
})
