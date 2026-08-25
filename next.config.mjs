import nextra from "nextra"

const withNextra = nextra({
  defaultShowCopyCode: true,
  contentDirBasePath: "/",
})

export default withNextra({
  reactStrictMode: true,
})
