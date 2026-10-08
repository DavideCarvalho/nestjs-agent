# agent-demo

## 0.0.71

### Patch Changes

- Updated dependencies [[`bb635d1`](https://github.com/DavideCarvalho/nestjs-agent/commit/bb635d19a7763024c13421f90aa21ca12c8fe58b)]:
  - @dudousxd/nestjs-agent-core@0.44.1
  - @dudousxd/nestjs-agent-dashboard@0.15.4
  - @dudousxd/nestjs-agent@1.24.2
  - @dudousxd/nestjs-agent-testing@0.28.0

## 0.0.70

### Patch Changes

- Updated dependencies [[`754b0d0`](https://github.com/DavideCarvalho/nestjs-agent/commit/754b0d00c8631a88763539958e6fe11823d81a3c)]:
  - @dudousxd/nestjs-agent-core@0.44.0
  - @dudousxd/nestjs-agent-dashboard@0.15.4
  - @dudousxd/nestjs-agent@1.24.1
  - @dudousxd/nestjs-agent-testing@0.28.0

## 0.0.69

### Patch Changes

- Updated dependencies [[`a4a098c`](https://github.com/DavideCarvalho/nestjs-agent/commit/a4a098c61b3246bce716a124b3fa3372b1af6cf5)]:
  - @dudousxd/nestjs-agent-core@0.43.0
  - @dudousxd/nestjs-agent@1.24.0
  - @dudousxd/nestjs-agent-testing@0.28.0
  - @dudousxd/nestjs-agent-dashboard@0.15.4

## 0.0.68

### Patch Changes

- Updated dependencies [[`d516616`](https://github.com/DavideCarvalho/nestjs-agent/commit/d51661667fe477f11c2cca25483ded3678d53f96), [`d516616`](https://github.com/DavideCarvalho/nestjs-agent/commit/d51661667fe477f11c2cca25483ded3678d53f96), [`d516616`](https://github.com/DavideCarvalho/nestjs-agent/commit/d51661667fe477f11c2cca25483ded3678d53f96)]:
  - @dudousxd/nestjs-agent-core@0.42.1
  - @dudousxd/nestjs-agent@1.23.1
  - @dudousxd/nestjs-agent-dashboard@0.15.4
  - @dudousxd/nestjs-agent-testing@0.27.0

## 0.0.67

### Patch Changes

- Updated dependencies [[`52703f0`](https://github.com/DavideCarvalho/nestjs-agent/commit/52703f077f5ae22ade28fbb5838d6591abcadc6e), [`8ba61cd`](https://github.com/DavideCarvalho/nestjs-agent/commit/8ba61cda56bb3c158284d5539325d971f332374f), [`40c040f`](https://github.com/DavideCarvalho/nestjs-agent/commit/40c040f43b2f8255b97104bef1c0159731d00842)]:
  - @dudousxd/nestjs-agent-core@0.42.0
  - @dudousxd/nestjs-agent@1.23.0
  - @dudousxd/nestjs-agent-testing@0.27.0
  - @dudousxd/nestjs-agent-dashboard@0.15.4

## 0.0.66

### Patch Changes

- [#319](https://github.com/DavideCarvalho/nestjs-agent/pull/319) [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The demo now passes `quota: { limits: { day: { tokens: 200_000 } } }`. It used to pass an `InMemoryQuotaStore`, which is not a valid `quota` option. The demo script also reads `GET /agent/quota` instead of the removed `/agent/quota/today`. The example now has a `typecheck` script, so this kind of drift fails `pnpm typecheck`.

- Updated dependencies [[`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`66305c4`](https://github.com/DavideCarvalho/nestjs-agent/commit/66305c47f0624ca3eafa0f9c298e40ad977ff064), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da)]:
  - @dudousxd/nestjs-agent-core@0.41.0
  - @dudousxd/nestjs-agent@1.22.0
  - @dudousxd/nestjs-agent-testing@0.26.1
  - @dudousxd/nestjs-agent-dashboard@0.15.4

## 0.0.65

### Patch Changes

- Updated dependencies [[`7136543`](https://github.com/DavideCarvalho/nestjs-agent/commit/71365431cd5afd16e937ab39bdcf886a71d7c5ae), [`cb8b15a`](https://github.com/DavideCarvalho/nestjs-agent/commit/cb8b15aa26bd5d7f68af40d41b4ddeba3d9b71dd), [`b233a41`](https://github.com/DavideCarvalho/nestjs-agent/commit/b233a418b411215e03e8bb02c32e13d685089f53), [`db48ea8`](https://github.com/DavideCarvalho/nestjs-agent/commit/db48ea8a7c281a111f4079a8e4ba9036244068c5), [`133975e`](https://github.com/DavideCarvalho/nestjs-agent/commit/133975e7b9aa9da44f708ce4a95940fb6f6440e4)]:
  - @dudousxd/nestjs-agent-core@0.40.0
  - @dudousxd/nestjs-agent@1.21.0
  - @dudousxd/nestjs-agent-testing@0.26.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.64

### Patch Changes

- Updated dependencies [[`aabc27e`](https://github.com/DavideCarvalho/nestjs-agent/commit/aabc27e544beda62c5b28849effa00edaa93608d)]:
  - @dudousxd/nestjs-agent-testing@0.25.1
  - @dudousxd/nestjs-agent@1.20.0

## 0.0.63

### Patch Changes

- Updated dependencies [[`86afcb7`](https://github.com/DavideCarvalho/nestjs-agent/commit/86afcb75e11f4b676439c215885371c706389ab2)]:
  - @dudousxd/nestjs-agent-core@0.39.0
  - @dudousxd/nestjs-agent@1.20.0
  - @dudousxd/nestjs-agent-testing@0.25.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.62

### Patch Changes

- Updated dependencies [[`dbd5592`](https://github.com/DavideCarvalho/nestjs-agent/commit/dbd55926dbda26d300d4a913173e7ad1182f4afc), [`dbd5592`](https://github.com/DavideCarvalho/nestjs-agent/commit/dbd55926dbda26d300d4a913173e7ad1182f4afc)]:
  - @dudousxd/nestjs-agent@1.19.3
  - @dudousxd/nestjs-agent-core@0.38.1
  - @dudousxd/nestjs-agent-dashboard@0.15.3
  - @dudousxd/nestjs-agent-testing@0.24.0

## 0.0.61

### Patch Changes

- Updated dependencies [[`2e3ae25`](https://github.com/DavideCarvalho/nestjs-agent/commit/2e3ae254d33123ee589008a1711d10c7b7c3f0ee)]:
  - @dudousxd/nestjs-agent-core@0.38.0
  - @dudousxd/nestjs-agent@1.19.2
  - @dudousxd/nestjs-agent-testing@0.24.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.60

### Patch Changes

- Updated dependencies [[`43fa891`](https://github.com/DavideCarvalho/nestjs-agent/commit/43fa891a5a48bcf2130d01c4952b7b767d5dd502)]:
  - @dudousxd/nestjs-agent-core@0.37.0
  - @dudousxd/nestjs-agent-testing@0.23.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3
  - @dudousxd/nestjs-agent@1.19.1

## 0.0.59

### Patch Changes

- Updated dependencies [[`3ed6542`](https://github.com/DavideCarvalho/nestjs-agent/commit/3ed654296e98ba93474c9edbf397ca10f1eb7c92)]:
  - @dudousxd/nestjs-agent-core@0.36.0
  - @dudousxd/nestjs-agent@1.19.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3
  - @dudousxd/nestjs-agent-testing@0.22.0

## 0.0.58

### Patch Changes

- Updated dependencies [[`754998a`](https://github.com/DavideCarvalho/nestjs-agent/commit/754998aee31b6e2325bf34371cd75806ef6a408b)]:
  - @dudousxd/nestjs-agent-core@0.35.0
  - @dudousxd/nestjs-agent@1.18.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3
  - @dudousxd/nestjs-agent-testing@0.22.0

## 0.0.57

### Patch Changes

- Updated dependencies [[`bf86406`](https://github.com/DavideCarvalho/nestjs-agent/commit/bf864065d8ec38e91350722feb9be0ce198467de)]:
  - @dudousxd/nestjs-agent@1.17.1

## 0.0.56

### Patch Changes

- Updated dependencies [[`3c9cb61`](https://github.com/DavideCarvalho/nestjs-agent/commit/3c9cb617a4ca911b201f224f148c34a345a3f573)]:
  - @dudousxd/nestjs-agent-core@0.34.0
  - @dudousxd/nestjs-agent@1.17.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3
  - @dudousxd/nestjs-agent-testing@0.22.0

## 0.0.55

### Patch Changes

- Updated dependencies [[`84d3e9f`](https://github.com/DavideCarvalho/nestjs-agent/commit/84d3e9f01cb3c07db63c3b1e59150589f83a249b)]:
  - @dudousxd/nestjs-agent@1.16.1

## 0.0.54

### Patch Changes

- Updated dependencies [[`6cfebc7`](https://github.com/DavideCarvalho/nestjs-agent/commit/6cfebc785e9d0350864dedcba3a15ec928dd28b1)]:
  - @dudousxd/nestjs-agent-core@0.33.0
  - @dudousxd/nestjs-agent@1.16.0
  - @dudousxd/nestjs-agent-testing@0.22.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.53

### Patch Changes

- Updated dependencies [[`68aee17`](https://github.com/DavideCarvalho/nestjs-agent/commit/68aee1787ea8a63279859ed99376849e1e8937b1)]:
  - @dudousxd/nestjs-agent-core@0.32.0
  - @dudousxd/nestjs-agent@1.15.0
  - @dudousxd/nestjs-agent-testing@0.21.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.52

### Patch Changes

- Updated dependencies [[`4c69aed`](https://github.com/DavideCarvalho/nestjs-agent/commit/4c69aedd3e4e81f32c08af5f3a52e7f9b561fced)]:
  - @dudousxd/nestjs-agent-core@0.31.0
  - @dudousxd/nestjs-agent@1.14.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3
  - @dudousxd/nestjs-agent-testing@0.20.0

## 0.0.51

### Patch Changes

- Updated dependencies [[`9bf7efd`](https://github.com/DavideCarvalho/nestjs-agent/commit/9bf7efd574aabcceeebd9730ddbe5f2eaaae6822)]:
  - @dudousxd/nestjs-agent-core@0.30.0
  - @dudousxd/nestjs-agent@1.13.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3
  - @dudousxd/nestjs-agent-testing@0.20.0

## 0.0.50

### Patch Changes

- Updated dependencies [[`39b6d0b`](https://github.com/DavideCarvalho/nestjs-agent/commit/39b6d0b56b3b165e2c685ba35192b3af2dcf6cfb)]:
  - @dudousxd/nestjs-agent-core@0.29.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3
  - @dudousxd/nestjs-agent@1.12.1
  - @dudousxd/nestjs-agent-testing@0.20.0

## 0.0.49

### Patch Changes

- Updated dependencies [[`37e2c2d`](https://github.com/DavideCarvalho/nestjs-agent/commit/37e2c2de47b5ec36dc209a0f11678f3627a93fa6)]:
  - @dudousxd/nestjs-agent-core@0.28.0
  - @dudousxd/nestjs-agent@1.12.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3
  - @dudousxd/nestjs-agent-testing@0.20.0

## 0.0.48

### Patch Changes

- Updated dependencies [[`cd2c790`](https://github.com/DavideCarvalho/nestjs-agent/commit/cd2c7909df1c88cc914ec6aa28940800e0dcd705)]:
  - @dudousxd/nestjs-agent-core@0.27.0
  - @dudousxd/nestjs-agent@1.11.0
  - @dudousxd/nestjs-agent-testing@0.20.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.47

### Patch Changes

- Updated dependencies [[`3b0fd1c`](https://github.com/DavideCarvalho/nestjs-agent/commit/3b0fd1c7f115f12f51d83bd3ada1c9e2b669f778)]:
  - @dudousxd/nestjs-agent@1.10.0

## 0.0.46

### Patch Changes

- Updated dependencies [[`50f76db`](https://github.com/DavideCarvalho/nestjs-agent/commit/50f76db3a7c283bdd576697578c449a4c5b7fcd2)]:
  - @dudousxd/nestjs-agent-core@0.26.0
  - @dudousxd/nestjs-agent@1.9.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3
  - @dudousxd/nestjs-agent-testing@0.19.0

## 0.0.45

### Patch Changes

- Updated dependencies [[`104c3a6`](https://github.com/DavideCarvalho/nestjs-agent/commit/104c3a6a0cc0cbf2d6b101fb648daa2565e1b856)]:
  - @dudousxd/nestjs-agent-core@0.25.0
  - @dudousxd/nestjs-agent@1.8.0
  - @dudousxd/nestjs-agent-testing@0.19.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.44

### Patch Changes

- Updated dependencies [[`a4dc582`](https://github.com/DavideCarvalho/nestjs-agent/commit/a4dc5823eea59e971404a53b4d7ce0fc7cda88b6)]:
  - @dudousxd/nestjs-agent-core@0.24.0
  - @dudousxd/nestjs-agent@1.7.0
  - @dudousxd/nestjs-agent-testing@0.18.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.43

### Patch Changes

- Updated dependencies [[`75eb415`](https://github.com/DavideCarvalho/nestjs-agent/commit/75eb415c98cde1ba3fdd8d0366774c5d7514bfdf)]:
  - @dudousxd/nestjs-agent-core@0.23.0
  - @dudousxd/nestjs-agent@1.6.0
  - @dudousxd/nestjs-agent-testing@0.17.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.42

### Patch Changes

- Updated dependencies [[`13b50e2`](https://github.com/DavideCarvalho/nestjs-agent/commit/13b50e24461194aec197e96b82bbee1afc4570c8)]:
  - @dudousxd/nestjs-agent-core@0.22.0
  - @dudousxd/nestjs-agent@1.5.0
  - @dudousxd/nestjs-agent-testing@0.16.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.41

### Patch Changes

- Updated dependencies [[`26254d2`](https://github.com/DavideCarvalho/nestjs-agent/commit/26254d2020408e1712555d074a1814a9ba97b66c)]:
  - @dudousxd/nestjs-agent-core@0.21.0
  - @dudousxd/nestjs-agent@1.4.0
  - @dudousxd/nestjs-agent-testing@0.15.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.40

### Patch Changes

- Updated dependencies [[`b410e83`](https://github.com/DavideCarvalho/nestjs-agent/commit/b410e836782605c13103ea3782e4146cb07aeefd)]:
  - @dudousxd/nestjs-agent-core@0.20.0
  - @dudousxd/nestjs-agent@1.3.0
  - @dudousxd/nestjs-agent-testing@0.14.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.39

### Patch Changes

- Updated dependencies [[`b6edbab`](https://github.com/DavideCarvalho/nestjs-agent/commit/b6edbab8897179a87dce50e6ac45f90b91f4b91f)]:
  - @dudousxd/nestjs-agent-core@0.19.0
  - @dudousxd/nestjs-agent@1.2.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3
  - @dudousxd/nestjs-agent-testing@0.13.0

## 0.0.38

### Patch Changes

- Updated dependencies [[`70a3766`](https://github.com/DavideCarvalho/nestjs-agent/commit/70a3766ffa662392394c28f3336146cc157b7f96)]:
  - @dudousxd/nestjs-agent-core@0.18.0
  - @dudousxd/nestjs-agent-testing@0.13.0
  - @dudousxd/nestjs-agent@1.1.2
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.37

### Patch Changes

- Updated dependencies [[`7e06e5a`](https://github.com/DavideCarvalho/nestjs-agent/commit/7e06e5ac9c3ec81732e3ff3b1714b627876097cd)]:
  - @dudousxd/nestjs-agent-core@0.17.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3
  - @dudousxd/nestjs-agent@1.1.1
  - @dudousxd/nestjs-agent-testing@0.12.0

## 0.0.36

### Patch Changes

- Updated dependencies [[`8a4ec35`](https://github.com/DavideCarvalho/nestjs-agent/commit/8a4ec35a9da5b697d71955a0a8437c810221e208), [`505702e`](https://github.com/DavideCarvalho/nestjs-agent/commit/505702e5df0b769d6cd78f76696c1bd569c11e68), [`8a4ec35`](https://github.com/DavideCarvalho/nestjs-agent/commit/8a4ec35a9da5b697d71955a0a8437c810221e208)]:
  - @dudousxd/nestjs-agent-core@0.16.0
  - @dudousxd/nestjs-agent-testing@0.12.0
  - @dudousxd/nestjs-agent@1.1.0
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.35

### Patch Changes

- Updated dependencies []:
  - @dudousxd/nestjs-agent-dashboard@0.15.3

## 0.0.34

### Patch Changes

- Updated dependencies []:
  - @dudousxd/nestjs-agent-core@0.15.5
  - @dudousxd/nestjs-agent-dashboard@0.15.2
  - @dudousxd/nestjs-agent@1.0.6
  - @dudousxd/nestjs-agent-testing@0.11.0

## 0.0.33

### Patch Changes

- Updated dependencies [[`3a3e75f`](https://github.com/DavideCarvalho/nestjs-agent/commit/3a3e75f6aa3b3efaaeb6235a0d4bb4048357458b)]:
  - @dudousxd/nestjs-agent-core@0.15.4
  - @dudousxd/nestjs-agent-dashboard@0.15.1
  - @dudousxd/nestjs-agent@1.0.5
  - @dudousxd/nestjs-agent-testing@0.11.0

## 0.0.32

### Patch Changes

- Updated dependencies [[`df889d9`](https://github.com/DavideCarvalho/nestjs-agent/commit/df889d953f7d92ace46d22b1d33db2cdab88f7c2)]:
  - @dudousxd/nestjs-agent-core@0.15.3
  - @dudousxd/nestjs-agent-dashboard@0.15.1
  - @dudousxd/nestjs-agent@1.0.4
  - @dudousxd/nestjs-agent-testing@0.11.0

## 0.0.31

### Patch Changes

- Updated dependencies [[`648fef6`](https://github.com/DavideCarvalho/nestjs-agent/commit/648fef61c336022ffb126ac15ab325387c05c49a)]:
  - @dudousxd/nestjs-agent-core@0.15.2
  - @dudousxd/nestjs-agent@1.0.3
  - @dudousxd/nestjs-agent-dashboard@0.15.1
  - @dudousxd/nestjs-agent-testing@0.11.0

## 0.0.30

### Patch Changes

- Updated dependencies []:
  - @dudousxd/nestjs-agent-core@0.15.1
  - @dudousxd/nestjs-agent-dashboard@0.15.1
  - @dudousxd/nestjs-agent@1.0.2
  - @dudousxd/nestjs-agent-testing@0.11.0

## 0.0.29

### Patch Changes

- Updated dependencies [[`3061f77`](https://github.com/DavideCarvalho/nestjs-agent/commit/3061f77548d48a8aa88b02eca46b04d24848646a)]:
  - @dudousxd/nestjs-agent-core@0.15.0
  - @dudousxd/nestjs-agent-dashboard@0.15.0
  - @dudousxd/nestjs-agent@1.0.1
  - @dudousxd/nestjs-agent-testing@0.11.0

## 0.0.28

### Patch Changes

- Updated dependencies [[`d7f2cf2`](https://github.com/DavideCarvalho/nestjs-agent/commit/d7f2cf260ab0e87a012b21d681f805eb6758129a), [`24c01fa`](https://github.com/DavideCarvalho/nestjs-agent/commit/24c01fae1792204892dfa082d58bdeaa84b1bdb8), [`24c01fa`](https://github.com/DavideCarvalho/nestjs-agent/commit/24c01fae1792204892dfa082d58bdeaa84b1bdb8), [`a60bd23`](https://github.com/DavideCarvalho/nestjs-agent/commit/a60bd2359bcdfa51c22fea60034635a0a5b3af41), [`a60bd23`](https://github.com/DavideCarvalho/nestjs-agent/commit/a60bd2359bcdfa51c22fea60034635a0a5b3af41), [`31caa9e`](https://github.com/DavideCarvalho/nestjs-agent/commit/31caa9e48e9b8be948b54dd252057a01355f4924)]:
  - @dudousxd/nestjs-agent-core@0.14.0
  - @dudousxd/nestjs-agent@1.0.0
  - @dudousxd/nestjs-agent-testing@0.11.0
  - @dudousxd/nestjs-agent-dashboard@0.15.0

## 0.0.27

### Patch Changes

- Updated dependencies [[`ad383f8`](https://github.com/DavideCarvalho/nestjs-agent/commit/ad383f823e0da2ac208c5cfb737eebb6046f4cf2)]:
  - @dudousxd/nestjs-agent@0.13.0

## 0.0.26

### Patch Changes

- Updated dependencies [[`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4)]:
  - @dudousxd/nestjs-agent-testing@0.10.0
  - @dudousxd/nestjs-agent-core@0.13.0
  - @dudousxd/nestjs-agent@0.12.0
  - @dudousxd/nestjs-agent-dashboard@0.15.0

## 0.0.25

### Patch Changes

- Updated dependencies [[`fe9fb99`](https://github.com/DavideCarvalho/nestjs-agent/commit/fe9fb9985131643ad9b2733a3c3658decdc585ab)]:
  - @dudousxd/nestjs-agent@0.11.1
  - @dudousxd/nestjs-agent-dashboard@0.14.1

## 0.0.24

### Patch Changes

- Updated dependencies [[`70f3d57`](https://github.com/DavideCarvalho/nestjs-agent/commit/70f3d57dcebd9aec631adc66c40d0715472115d9)]:
  - @dudousxd/nestjs-agent-core@0.12.0
  - @dudousxd/nestjs-agent@0.11.0
  - @dudousxd/nestjs-agent-dashboard@0.14.0
  - @dudousxd/nestjs-agent-testing@0.9.0

## 0.0.23

### Patch Changes

- Updated dependencies [[`c8ba932`](https://github.com/DavideCarvalho/nestjs-agent/commit/c8ba932cf17f230934b6c8bc860e5fbf7b2a12cf), [`7c27376`](https://github.com/DavideCarvalho/nestjs-agent/commit/7c273763eeb6d5841028612d81acc63b2a8dd4eb), [`c303eda`](https://github.com/DavideCarvalho/nestjs-agent/commit/c303eda81d72db799a896e8d651765deb2cd5a03), [`2301c39`](https://github.com/DavideCarvalho/nestjs-agent/commit/2301c39cb162c04b44cdc7b40296e01cc3b98174), [`d115cb7`](https://github.com/DavideCarvalho/nestjs-agent/commit/d115cb7973aafa539eafbb1e488259044a562069)]:
  - @dudousxd/nestjs-agent-dashboard@0.14.0
  - @dudousxd/nestjs-agent-testing@0.9.0
  - @dudousxd/nestjs-agent-core@0.11.0
  - @dudousxd/nestjs-agent@0.10.1

## 0.0.22

### Patch Changes

- Updated dependencies [[`a32a2da`](https://github.com/DavideCarvalho/nestjs-agent/commit/a32a2daedd07ea1fe2aa8297b3d4fbb3de8178aa)]:
  - @dudousxd/nestjs-agent-dashboard@0.13.1

## 0.0.21

### Patch Changes

- Updated dependencies [[`8378970`](https://github.com/DavideCarvalho/nestjs-agent/commit/8378970805d0e420108966f9af79ef978351af6f)]:
  - @dudousxd/nestjs-agent-dashboard@0.13.0

## 0.0.20

### Patch Changes

- Updated dependencies [[`8cac7dd`](https://github.com/DavideCarvalho/nestjs-agent/commit/8cac7dd65ef59b778f32e633ccaa4ec1d3f9d0a3)]:
  - @dudousxd/nestjs-agent-dashboard@0.12.0

## 0.0.19

### Patch Changes

- Updated dependencies [[`a67ccd9`](https://github.com/DavideCarvalho/nestjs-agent/commit/a67ccd9fefe4605816995a78c4da9f69495000c9)]:
  - @dudousxd/nestjs-agent-dashboard@0.11.0

## 0.0.18

### Patch Changes

- Updated dependencies [[`bbea1b7`](https://github.com/DavideCarvalho/nestjs-agent/commit/bbea1b70bb4feebbefffb8f96d4781770d44be9d)]:
  - @dudousxd/nestjs-agent-dashboard@0.10.1

## 0.0.17

### Patch Changes

- Updated dependencies [[`a5e34a9`](https://github.com/DavideCarvalho/nestjs-agent/commit/a5e34a9ef8f9013aba6113e719dd2a0ce6e67500)]:
  - @dudousxd/nestjs-agent-dashboard@0.10.0

## 0.0.16

### Patch Changes

- Updated dependencies [[`9f2a22c`](https://github.com/DavideCarvalho/nestjs-agent/commit/9f2a22c978b6268cd8d7443fd3a21e524f415cf5)]:
  - @dudousxd/nestjs-agent@0.10.0

## 0.0.15

### Patch Changes

- Updated dependencies [[`dc4a586`](https://github.com/DavideCarvalho/nestjs-agent/commit/dc4a5866c3225602c8887c569751f5e5ceedf830)]:
  - @dudousxd/nestjs-agent-dashboard@0.9.1

## 0.0.14

### Patch Changes

- Updated dependencies [[`f614883`](https://github.com/DavideCarvalho/nestjs-agent/commit/f614883c65685f1aeb494a43aaab93e30a281281)]:
  - @dudousxd/nestjs-agent-dashboard@0.9.0

## 0.0.13

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0
  - @dudousxd/nestjs-agent@0.9.0
  - @dudousxd/nestjs-agent-dashboard@0.8.0
  - @dudousxd/nestjs-agent-testing@0.8.1

## 0.0.12

### Patch Changes

- Updated dependencies [[`107fcc2`](https://github.com/DavideCarvalho/nestjs-agent/commit/107fcc2c0079f97c3cc9ff8c83f2dc41070244d5)]:
  - @dudousxd/nestjs-agent-core@0.9.0
  - @dudousxd/nestjs-agent@0.8.2
  - @dudousxd/nestjs-agent-testing@0.8.0
  - @dudousxd/nestjs-agent-dashboard@0.8.0

## 0.0.11

### Patch Changes

- Updated dependencies [[`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f)]:
  - @dudousxd/nestjs-agent-core@0.8.0
  - @dudousxd/nestjs-agent-testing@0.7.0
  - @dudousxd/nestjs-agent-dashboard@0.8.0
  - @dudousxd/nestjs-agent@0.8.1

## 0.0.10

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0
  - @dudousxd/nestjs-agent@0.8.0
  - @dudousxd/nestjs-agent-dashboard@0.7.0
  - @dudousxd/nestjs-agent-testing@0.6.1

## 0.0.9

### Patch Changes

- Updated dependencies [[`71b8d42`](https://github.com/DavideCarvalho/nestjs-agent/commit/71b8d42d211d28516929298c44e6868d8925cc02)]:
  - @dudousxd/nestjs-agent@0.7.0
  - @dudousxd/nestjs-agent-dashboard@0.7.0

## 0.0.8

### Patch Changes

- Updated dependencies [[`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1), [`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263), [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1)]:
  - @dudousxd/nestjs-agent@0.6.0
  - @dudousxd/nestjs-agent-core@0.6.0
  - @dudousxd/nestjs-agent-testing@0.6.0
  - @dudousxd/nestjs-agent-dashboard@0.6.0

## 0.0.7

### Patch Changes

- Updated dependencies [[`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5), [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5)]:
  - @dudousxd/nestjs-agent-core@0.5.0
  - @dudousxd/nestjs-agent@0.5.0
  - @dudousxd/nestjs-agent-testing@0.5.0
  - @dudousxd/nestjs-agent-dashboard@0.5.0

## 0.0.6

### Patch Changes

- Updated dependencies [[`66e9ad8`](https://github.com/DavideCarvalho/nestjs-agent/commit/66e9ad80347c6e1488041e643a1e8d881410de6f)]:
  - @dudousxd/nestjs-agent@0.4.1

## 0.0.5

### Patch Changes

- Updated dependencies [[`619a097`](https://github.com/DavideCarvalho/nestjs-agent/commit/619a09771830db31739594813b0b937b844939f6)]:
  - @dudousxd/nestjs-agent-dashboard@0.4.1

## 0.0.4

### Patch Changes

- Updated dependencies [[`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31), [`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31)]:
  - @dudousxd/nestjs-agent-core@0.4.0
  - @dudousxd/nestjs-agent@0.4.0
  - @dudousxd/nestjs-agent-testing@1.0.0
  - @dudousxd/nestjs-agent-dashboard@0.4.0

## 0.0.3

### Patch Changes

- Updated dependencies [[`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46)]:
  - @dudousxd/nestjs-agent-core@0.3.3
  - @dudousxd/nestjs-agent@0.3.3
  - @dudousxd/nestjs-agent-dashboard@0.3.1
  - @dudousxd/nestjs-agent-testing@0.3.3

## 0.0.2

### Patch Changes

- Updated dependencies
- Updated dependencies [ad8e446]
  - @dudousxd/nestjs-agent@0.3.2
  - @dudousxd/nestjs-agent-core@0.3.2
  - @dudousxd/nestjs-agent-testing@0.3.2
  - @dudousxd/nestjs-agent-dashboard@0.3.1

## 0.0.1

### Patch Changes

- Updated dependencies [[`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04)]:
  - @dudousxd/nestjs-agent-core@0.3.1
  - @dudousxd/nestjs-agent-testing@0.3.1
  - @dudousxd/nestjs-agent-dashboard@0.3.1
  - @dudousxd/nestjs-agent@0.3.1
