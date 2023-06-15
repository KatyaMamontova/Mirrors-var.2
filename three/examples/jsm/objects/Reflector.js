import {
	Color,
	Matrix4,
	Mesh,
	PerspectiveCamera,
	Plane,
	ShaderMaterial,
	UniformsUtils,
	Vector3,
	Vector4,
	WebGLRenderTarget,
	HalfFloatType,
	NoToneMapping,
	LinearSRGBColorSpace,
	DepthTexture,
	UnsignedShortType
} from 'three';

class Reflector extends Mesh {

	constructor(geometry, options = {}) {

		super(geometry);

		this.isReflector = true;

		this.type = 'Reflector';
		this.camera = new PerspectiveCamera();

		const scope = this;

		const color = (options.color !== undefined) ? new Color(options.color) : new Color(0x7F7F7F);
		const textureWidth = options.textureWidth || 512;
		const textureHeight = options.textureHeight || 512;
		const clipBias = options.clipBias || 0;
		const shader = options.shader || Reflector.ReflectorShader;
		const multisample = (options.multisample !== undefined) ? options.multisample : 4;
		const recursion = options.recursion; //было бы логично, но этого не было
		//

		const reflectorPlane = new Plane();
		const normal = new Vector3();
		const reflectorWorldPosition = new Vector3();
		const cameraWorldPosition = new Vector3();
		const rotationMatrix = new Matrix4();
		const lookAtPosition = new Vector3(0, 0, - 1);
		const clipPlane = new Vector4();
		const viewport = new Vector4();

		const view = new Vector3();
		const target = new Vector3();
		const q = new Vector4();

		const textureMatrix = new Matrix4();
		const virtualCamera = this.camera;

		/* var parameters = {
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			format: RGBFormat,
			stencilBuffer: false
		}; */

		const renderTarget = new WebGLRenderTarget(textureWidth, textureHeight, { samples: multisample, type: HalfFloatType });

		renderTarget.depthBuffer = true;
		renderTarget.depthTexture = new DepthTexture();
		renderTarget.depthTexture.type = UnsignedShortType;

		/* if (!Math.isPowerOfTwo(textureWidth) || !Math.isPowerOfTwo(textureHeight)) {
			renderTarget.texture.generateMipmaps = false;
		} */

		const material = new ShaderMaterial({
			uniforms: UniformsUtils.clone(shader.uniforms),
			fragmentShader: shader.fragmentShader,
			vertexShader: shader.vertexShader,
			transparent: true
		});

		material.uniforms['tDiffuse'].value = renderTarget.texture;
		material.uniforms['tDepth'].value = renderTarget.depthTexture;
		material.uniforms['color'].value = color;
		material.uniforms['textureMatrix'].value = textureMatrix;

		this.material = material;

		this.onBeforeRender = function (renderer, scene, camera) {

			reflectorWorldPosition.setFromMatrixPosition(scope.matrixWorld);
			cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);

			rotationMatrix.extractRotation(scope.matrixWorld);

			normal.set(0, 0, 1);
			normal.applyMatrix4(rotationMatrix);

			view.subVectors(reflectorWorldPosition, cameraWorldPosition);

			// Avoid rendering when reflector is facing away

			if (view.dot(normal) > 0) return;

			view.reflect(normal).negate();
			view.add(reflectorWorldPosition);

			rotationMatrix.extractRotation(camera.matrixWorld);

			lookAtPosition.set(0, 0, - 1);
			lookAtPosition.applyMatrix4(rotationMatrix);
			lookAtPosition.add(cameraWorldPosition);

			target.subVectors(reflectorWorldPosition, lookAtPosition);
			target.reflect(normal).negate();
			target.add(reflectorWorldPosition);

			virtualCamera.position.copy(view);
			virtualCamera.up.set(0, 1, 0);
			virtualCamera.up.applyMatrix4(rotationMatrix);
			virtualCamera.up.reflect(normal);
			virtualCamera.lookAt(target);

			virtualCamera.far = camera.far; // Used in WebGLBackground

			virtualCamera.updateMatrixWorld();
			virtualCamera.projectionMatrix.copy(camera.projectionMatrix);

			this.material.uniforms.cameraNear.value = camera.near;
			this.material.uniforms.cameraFar.value = camera.far;

			// Update the texture matrix
			textureMatrix.set(
				0.5, 0.0, 0.0, 0.5,
				0.0, 0.5, 0.0, 0.5,
				0.0, 0.0, 0.5, 0.5,
				0.0, 0.0, 0.0, 1.0
			);
			textureMatrix.multiply(virtualCamera.projectionMatrix);
			textureMatrix.multiply(virtualCamera.matrixWorldInverse);
			textureMatrix.multiply(scope.matrixWorld);

			// Now update projection matrix with new clip plane, implementing code from: http://www.terathon.com/code/oblique.html
			// Paper explaining this technique: http://www.terathon.com/lengyel/Lengyel-Oblique.pdf
			reflectorPlane.setFromNormalAndCoplanarPoint(normal, reflectorWorldPosition);
			reflectorPlane.applyMatrix4(virtualCamera.matrixWorldInverse);

			clipPlane.set(reflectorPlane.normal.x, reflectorPlane.normal.y, reflectorPlane.normal.z, reflectorPlane.constant);

			const projectionMatrix = virtualCamera.projectionMatrix;

			q.x = (Math.sign(clipPlane.x) + projectionMatrix.elements[8]) / projectionMatrix.elements[0];
			q.y = (Math.sign(clipPlane.y) + projectionMatrix.elements[9]) / projectionMatrix.elements[5];
			q.z = - 1.0;
			q.w = (1.0 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];

			// Calculate the scaled plane vector
			clipPlane.multiplyScalar(2.0 / clipPlane.dot(q));

			// Replacing the third row of the projection matrix
			projectionMatrix.elements[2] = clipPlane.x;
			projectionMatrix.elements[6] = clipPlane.y;
			projectionMatrix.elements[10] = clipPlane.z + 1.0 - clipBias;
			projectionMatrix.elements[14] = clipPlane.w;

			// Render

			//renderTarget.texture.encoding = renderer.outputEncoding;
			scope.visible = false;

			const currentRenderTarget = renderer.getRenderTarget();

			const currentXrEnabled = renderer.xr.enabled;
			const currentShadowAutoUpdate = renderer.shadowMap.autoUpdate;
			const currentOutputColorSpace = renderer.outputColorSpace;
			const currentToneMapping = renderer.toneMapping;

			renderer.xr.enabled = false; // Avoid camera modification
			renderer.shadowMap.autoUpdate = false; // Avoid re-computing shadows
			renderer.outputColorSpace = LinearSRGBColorSpace;
			renderer.toneMapping = NoToneMapping;

			renderer.setRenderTarget(renderTarget);

			renderer.state.buffers.depth.setMask(true); // make sure the depth buffer is writable so it can be properly cleared, see #18897

			if (renderer.autoClear === false) renderer.clear();
			renderer.render(scene, virtualCamera);

			renderer.xr.enabled = currentXrEnabled;
			renderer.shadowMap.autoUpdate = currentShadowAutoUpdate;
			renderer.outputColorSpace = currentOutputColorSpace;
			renderer.toneMapping = currentToneMapping;

			renderer.setRenderTarget(currentRenderTarget);

			// Restore viewport

			var bounds = camera.bounds;

			if (bounds !== undefined) {

				var size = renderer.getSize();
				var pixelRatio = renderer.getPixelRatio();

				viewport.x = bounds.x * size.width * pixelRatio;
				viewport.y = bounds.y * size.height * pixelRatio;
				viewport.z = bounds.z * size.width * pixelRatio;
				viewport.w = bounds.w * size.height * pixelRatio;

				renderer.state.viewport(viewport);

			}

			scope.visible = true;

			/* const viewport = camera.viewport;

			if (viewport !== undefined) {

				renderer.state.viewport(viewport);

			}

			scope.visible = true; */

		};

		this.getRenderTarget = function () {

			return renderTarget;

		};

		this.dispose = function () {

			renderTarget.dispose();
			scope.material.dispose();

		};

	}

}

Reflector.ReflectorShader = {

	uniforms: {

		'color': {
			value: null
		},

		'tDiffuse': {
			value: null
		},

		'tDepth': {
			value: null
		},

		'textureMatrix': {
			value: null
		},

		'cameraNear': {
			type: 'f',
			value: 0
		},

		'cameraFar': {
			type: 'f',
			value: 0
		},

	},

	vertexShader: /* glsl */`
		uniform mat4 textureMatrix;
		varying vec4 vUv;

		#include <common>
		#include <logdepthbuf_pars_vertex>

		void main() {

			vUv = textureMatrix * vec4( position, 1.0 ); /*масштабирование отражения*/

			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); /*расстояние между отражеиями*/

			#include <logdepthbuf_vertex>

		}`,

	fragmentShader: /* glsl */`
        #include <packing>
		uniform vec3 color;
		uniform sampler2D tDiffuse;
		uniform sampler2D depthSampler;
        uniform sampler2D tDepth;
        uniform float cameraNear;
        uniform float cameraFar;
		varying vec4 vUv;

		#include <logdepthbuf_pars_fragment>

		float blendOverlay( float base, float blend ) {
			
			/*размытие светлых пятен в отражениях*/
			return( base < 0.5 ? ( 2.0 * base * blend ) : ( 1.0 - 2.0 * ( 1.0 - base ) * ( 1.0 - blend ) ) );

		}

		vec3 blendOverlay( vec3 base, vec3 blend ) {

			return vec3( blendOverlay( base.r, blend.r ), blendOverlay( base.g, blend.g ), blendOverlay( base.b, blend.b ) );

		}
        
        float readDepth( sampler2D depthSampler, vec4 coord ) {
                
           float fragCoordZ = texture2DProj( depthSampler, coord ).x;
           float viewZ = perspectiveDepthToViewZ( fragCoordZ, cameraNear, cameraFar );
           return viewZToOrthographicDepth( viewZ, cameraNear, cameraFar );
            
        }

		void main() {

			#include <logdepthbuf_fragment>
			

			vec4 base = texture2DProj( tDiffuse, vUv );
			float depth = readDepth( tDepth, vUv );
			gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 - ( depth * 300.0 ) ); /*вот здесь МОЖНО СДЕЛАТЬ ОТРАЖЕНИЕ ТУСКЛЫМ*/


			#include <tonemapping_fragment>
			#include <encodings_fragment>

		}`
};

export { Reflector };
