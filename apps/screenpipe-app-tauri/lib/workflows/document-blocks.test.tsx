// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React, {useState} from "react";
import {it, expect, afterEach, vi} from "vitest";
import {render, screen, fireEvent, cleanup, within} from "@testing-library/react";
import {DocumentBlockEditor} from "../../../../packages/workflows-ui/src/document-block-editor";
import {orderedBlockIds, parseDocumentLayout, type DocumentLayout} from "../../../../packages/workflows-ui/src/document-blocks";
import {guideWithBlockIds, preserveGuideBlocks, parseGuide, guideMarkdown, guideHtml, type WorkflowGuide} from "../../../../packages/workflows-ui/src/guide";
import {fixtureWorkflowAnalysis} from "../../../../packages/workflows-ui/src/fixture-platform";
afterEach(cleanup);
const blocks = [{id:"text",label:"Introduction",content:<p>Original text</p>},{id:"image",label:"Screenshot",content:<img alt="Source capture" src="data:image/png;base64,YQ=="/>},{id:"video",label:"Video",content:<video aria-label="Original video"/>}];
function Editor({initial,save=vi.fn()}: {initial?:DocumentLayout; save?:(layout:DocumentLayout)=>void}) {
 const [layout,setLayout] = useState(initial);
 return <DocumentBlockEditor blocks={blocks} layout={layout} onChange={next=>{setLayout(next);save(next)}}/>;
}
const order = (container:HTMLElement)=>Array.from(container.querySelectorAll('[data-block-id]')).map(node=>node.getAttribute('data-block-id'));
it("moves image and video independently with keyboard and drag, then restores saved order",()=>{
 const save=vi.fn(); const first=render(<Editor save={save}/>);
 fireEvent.keyDown(screen.getByRole('button',{name:'Move Screenshot'}),{key:'ArrowUp',altKey:true});
 expect(order(first.container)).toEqual(['image','text','video']);
 const dataTransfer={setData:vi.fn(),effectAllowed:'',dropEffect:''};
 fireEvent.dragStart(screen.getByRole('button',{name:'Move Video'}),{dataTransfer});
 fireEvent.dragOver(screen.getByRole('region',{name:'Screenshot block'}),{dataTransfer});
 fireEvent.drop(screen.getByRole('region',{name:'Screenshot block'}),{dataTransfer});
 expect(order(first.container)).toEqual(['video','image','text']);
 const saved=parseDocumentLayout(JSON.parse(JSON.stringify(save.mock.calls.at(-1)![0])));
 first.unmount(); const next=render(<Editor initial={saved}/>);
 expect(order(next.container)).toEqual(['video','image','text']);
 expect(screen.getByAltText('Source capture')).toBeVisible();
});
it("inserts, edits, reloads and deletes a heading without changing source blocks",()=>{
 const save=vi.fn(); const view=render(<Editor save={save}/>);
 fireEvent.click(screen.getByRole('button',{name:'Add block after Introduction'}));
 fireEvent.click(screen.getByRole('button',{name:'Heading',exact:true}));
 fireEvent.change(screen.getByRole('textbox',{name:'Heading block'}),{target:{value:'A useful note'}});
 const saved=save.mock.calls.at(-1)![0];
 expect(saved.order[1]).toMatch(/^custom\//);
 view.unmount();render(<Editor initial={saved}/>);
 expect(screen.getByRole('textbox',{name:'Heading block'})).toHaveValue('A useful note');
 fireEvent.click(screen.getByRole('button',{name:'Move heading block'}));
 fireEvent.click(screen.getByRole('button',{name:'Delete block'}));
 expect(screen.queryByRole('textbox',{name:'Heading block'})).toBeNull();
 expect(screen.getByText('Original text')).toBeVisible();
});
it("accepts explicit HTTPS media and rejects script URLs and oversized saved layouts",()=>{
 const view=render(<Editor/>);
 fireEvent.click(screen.getByRole('button',{name:'Add block after Introduction'}));
 fireEvent.click(screen.getByRole('button',{name:'Image',exact:true}));
 fireEvent.change(screen.getByRole('textbox',{name:'Image URL'}),{target:{value:'javascript:alert(1)'}});
 fireEvent.submit(screen.getByRole('textbox',{name:'Image URL'}).closest('form')!);
 expect(screen.getByRole('alert')).toHaveTextContent('HTTPS');
 fireEvent.change(screen.getByRole('textbox',{name:'Image URL'}),{target:{value:'https://example.com/image.png'}});
 fireEvent.submit(screen.getByRole('textbox',{name:'Image URL'}).closest('form')!);
 expect(screen.getByAltText('SOP image')).toHaveAttribute('src','https://example.com/image.png');
 expect(()=>parseDocumentLayout({order:[],added:[{id:'custom/test',type:'video',text:'',url:'file:///private'}]})).toThrow();
 expect(()=>parseDocumentLayout({order:Array(401).fill('x'),added:[]})).toThrow();
});
it("places a newly completed video first while preserving an explicitly moved video",()=>{
 expect(orderedBlockIds(['generated-video','text','image'],{order:['image','text'],added:[]})).toEqual(['generated-video','image','text']);
 expect(orderedBlockIds(['generated-video','text','image'],{order:['image','text','generated-video'],added:[]})).toEqual(['image','text','generated-video']);
});
it("preserves custom content and identities across assistant edits, persistence and exports",()=>{
 const guide=guideWithBlockIds({version:1,workflowKey:'test',sourceRevision:1,title:'Guide',summary:'Summary',prerequisites:[],steps:[{title:'First',instruction:'Do it',sourceStage:null,includeImage:false,expectedResult:'Done'}],exceptions:[],completion:[],questions:[]} as WorkflowGuide);
 guide.documentLayout={order:['custom/note','summary'],added:[{id:'custom/note',type:'heading',text:'Team note'}]};
 const edited=preserveGuideBlocks(guide,{...guide,summary:'Changed',documentLayout:undefined,steps:[{...guide.steps[0],blockId:undefined,instruction:'Do it carefully'}]});
 const restored=parseGuide(JSON.parse(JSON.stringify(edited)));
 expect(restored.steps[0].blockId).toBe(guide.steps[0].blockId);
 expect(restored.documentLayout).toEqual(guide.documentLayout);
 expect(guideMarkdown(restored)).toContain('# Guide\n\n## Team note');
 const html=guideHtml(restored,fixtureWorkflowAnalysis.analysis.workflows[0],false);
 expect(html.indexOf('Team note')).toBeLessThan(html.indexOf('Changed'));
 const replacement=preserveGuideBlocks(guide,{...guide,steps:[{...guide.steps[0],blockId:undefined,title:'New step'}]});
 expect(replacement.steps[0].blockId).not.toBe(guide.steps[0].blockId);
});
