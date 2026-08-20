import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'

Object.defineProperty(window, '__dshDesktopReactRuntime', {
  configurable: true,
  value: { React, ReactDOM, ReactDOMClient, jsxRuntime },
})
