import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { AgentMessage } from '../chat/AgentMessage'
import { TUTOR_BODY_SELECTOR, tutorBodyVisible } from './TutoringPane'

const rect=(left:number,top:number,width:number,height:number)=>({left,top,width,height,right:left+width,bottom:top+height})
const visible=()=>({documentVisible:true,connected:true,hasContent:true,styleVisible:true,hasClientRect:true,isIntersecting:true,
  intersectionRect:rect(0,0,300,79),bodyRect:rect(0,0,300,1874),rootRect:rect(0,0,300,79),viewportRect:rect(0,0,1200,800)})

it('uses the existing AgentMessage Markdown body separately from its source and actions',()=>{
  const html=renderToStaticMarkup(createElement(AgentMessage,{message:{role:'agent',text:'获准正文',phase:'settled'},sourceLabel:'来源标签'},
    createElement('p',null,'原 Job 与来源'),createElement('button',null,'回应')))
  expect(TUTOR_BODY_SELECTOR).toBe(':scope > .chat-message.agent > .turn-body')
  expect(html).toContain('<div class="turn-body"><p>获准正文</p></div>')
  expect(html.indexOf('来源标签')).toBeLessThan(html.indexOf('class="turn-body"'))
  expect(html.indexOf('原 Job 与来源')).toBeGreaterThan(html.indexOf('<p>获准正文</p></div>'))
})

it('accepts genuine body pixels in a79px scroller even below five percent of a long reply',()=>{
  const facts=visible()
  expect(facts.intersectionRect.height/facts.bodyRect.height).toBeLessThan(0.05)
  expect(tutorBodyVisible(facts)).toBe(true)
  expect(tutorBodyVisible({...facts,bodyRect:rect(0,0,300,28),intersectionRect:rect(0,0,300,28)})).toBe(true)
  expect(tutorBodyVisible({...facts,intersectionRect:rect(0,0,300,0.5)})).toBe(true)
})

it('rejects only-source scrolling and stale intersections when the real body is outside the scroller',()=>{
  expect(tutorBodyVisible({...visible(),bodyRect:rect(0,-1900,300,1874)})).toBe(false)
  expect(tutorBodyVisible({...visible(),bodyRect:rect(0,80,300,1874)})).toBe(false)
  expect(tutorBodyVisible({...visible(),rootRect:rect(0,900,300,79),bodyRect:rect(0,900,300,1874)})).toBe(false)
})

it.each(['documentVisible','connected','hasContent','styleVisible','hasClientRect','isIntersecting'] as const)(
  'does not report the body when %s is false',flag=>expect(tutorBodyVisible({...visible(),[flag]:false})).toBe(false))

it('rejects edge contact and malformed or zero actual geometry',()=>{
  const facts=visible()
  expect(tutorBodyVisible({...facts,intersectionRect:rect(0,0,300,0)})).toBe(false)
  expect(tutorBodyVisible({...facts,intersectionRect:rect(0,0,0,79)})).toBe(false)
  expect(tutorBodyVisible({...facts,bodyRect:rect(0,0,300,0)})).toBe(false)
  expect(tutorBodyVisible({...facts,rootRect:rect(0,0,300,0)})).toBe(false)
  expect(tutorBodyVisible({...facts,viewportRect:rect(0,0,0,800)})).toBe(false)
  expect(tutorBodyVisible({...facts,intersectionRect:rect(0,0,300,NaN)})).toBe(false)
})
